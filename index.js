const DirectusSDK = require("@directus/sdk-js");
const fs = require('fs');
const path = require('path');
const rimraf = require('rimraf');

/**
 * Convert `const http` to variable to change protocol from project options
 */
let http = require('https');
/**
 * Default upload image path
 */
let uploadImagesDir = './.cache-directus/img-cache'

// TODO ADD CLEANUP OF UNUSED IMAGES / FILES
let download = async (url, dest, dir = uploadImagesDir) => {

  const imgName = dest;

  dest = dir + '/' + dest;

  const cleanImageName = path.resolve(dest);

  if (fs.existsSync(dest)) return cleanImageName;

  console.log(' -- Downloading Resource: ' + imgName);

  return new Promise((resolve, reject) => {
    var file = fs.createWriteStream(dest);
    http.get(url, function (response) {
      response.pipe(file);
      file.on('finish', function () {
        resolve(cleanImageName);
      });
    }).on('error', function (err) {
      fs.unlink(dest);
      reject(err.message);
    });
  });
};

function prepareAssetsFolder(dir = uploadImagesDir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  rimraf.sync(`${dir}/*`);
}

function sanitizeFields(fields) {
  Object.keys(fields).forEach((key) => {
    if (fields[key] === null || fields[key] === undefined) {
      delete fields[key];
    }
  });
  return fields;
}

function sanitizeItem(fields) {
  let { id, title, slug, path, date, content, excerpt } = fields;

  if (id) {
    delete fields.id;
    fields._directusID = id;
  }

  return sanitizeFields(fields);
}

/**
 * Convert nested object to flat object
 * https://stackoverflow.com/questions/34513964/how-to-convert-this-nested-object-into-a-flat-object
 * */
function traverseAndFlatten(currentNode, target, flattenedKey) {
  for (var key in currentNode) {
    if (currentNode.hasOwnProperty(key)) {
      var newKey;
      if (flattenedKey === undefined) {
        newKey = key;
      } else {
        newKey = flattenedKey + '__' + key;
      }

      var value = currentNode[key];
      if (typeof value === "object") {
        traverseAndFlatten(value, target, newKey);
      } else {
        target[newKey] = value;
      }
    }
  }
}

function flatten(obj) {
  var flattenedObject = {};
  traverseAndFlatten(obj, flattenedObject);
  return flattenedObject;
}
/**
 * End. https://stackoverflow.com/questions/34513964/how-to-convert-this-nested-object-into-a-flat-object
 * */

function uniqueArray(array = []) {
  return array.filter((item, pos, self) => self.indexOf(item) == pos)
}

class DirectusSource {
  static defaultOptions() {
    return {
      typeName: 'Directus',
      apiUrl: undefined,
      project: '',
      staticToken: undefined,
      email: undefined,
      password: undefined,
      maxRetries: 3,
      reconnectTimeout: 10000,
      collections: []
    }
  }

  constructor(api, options) {
    this.api = api;
    this.options = options;

    /**
     * Options for setting download protocol && images upload directory
     */
    if (options.global) {
      if (options.global.protocol) {
        http = require(options.global.protocol)
      }
      if (options.global.uploadImagesDir) {
        uploadImagesDir = options.global.uploadImagesDir
      }
    }
    api.loadSource(args => this.fetchContent(args));
  }

  async fetchContent(store) {
    const { addCollection, getContentType, slugify } = store
    const { apiUrl, project, staticToken, email, password, collections, maxRetries, reconnectTimeout } = this.options

    const client = new DirectusSDK(apiUrl);

    let retries = 0;

    let connect = async () => {
      return new Promise(async (resolve, reject) => {
        try {
          await client.auth.login(Object.assign({ email, password }));
          resolve(await client.collections.read());
        } catch (e) {
          console.error("DIRECTUS ERROR: Can not login to Directus", e);

          if (retries < maxRetries) {
            retries++;
            console.log("DIRECTUS - Retrying to connect in 10 seconds...");

            setTimeout(async () => {
              await connect();
            }, reconnectTimeout);
          } else {
            reject(process.exit(1))
            throw new Error("DIRECTUS ERROR: Can not login to Directus");
          }
        }
      });
    }

    if (email && password) {
      let data = await connect();
    }

    console.log("DIRECTUS: Loading data from Directus at: " + apiUrl);

    if (collections.length <= 0) {
      console.error("DIRECTUS ERROR: No Directus collections specified!");
      process.exit(1)
      throw new Error("DIRECTUS ERROR: No Directus collections specified!");
    }

    for (const collection of collections) {
      let collectionName;
      let params;
      let directusPathName;
      if (typeof collection === 'object') {
        collectionName = collection.name;
        directusPathName = collection.directusPathName || collectionName
        delete collection.name;
        params = collection;
      } else {
        collectionName = collection;
      }

      try {
        if (!params.limit) {
          params.limit = -1;
        }

        let data = await client.items(directusPathName).read(params);
        data = data.data;

        let route;

        if (params) {
          if (params.hasRoute) {
            route = `/${slugify(collectionName)}/:slug`;
          } else if (params.route) {
            if (typeof params.route === 'function') {
              route = params.route(collectionName, collection, slugify);
            } else {
              route = params.route;
            }
          }
        }

        const contentType = addCollection({
          typeName: collectionName, // TODO change name creation
          route: route
        })

        for (let item of data) {

          /**
           * Convert nested object to flat object
           */
          if (params.flat) {
            item = flatten(item);
          }

          /**
           * Check if params.sanitizeID === false to sanitize Node ID or not
           */
          if (params.sanitizeID === false) {
            contentType.addNode(sanitizeFields(item))
          }
          else {
            contentType.addNode(sanitizeItem(item))
          }
        }

      } catch (e) {
        console.error("DIRECTUS ERROR: Can not load data for collection '", e);
        process.exit(1)
        throw "DIRECTUS ERROR: Can not load data for collection '" + collectionName + "'!";
      }
    }

    try {
      let files = await client.files.read();
      files = files.data;

      const authToken = client.auth.token;

      prepareAssetsFolder();

      const filesDownloaded = await Promise.allSettled(files.map(async file => {
        const { id, filename_download } = file;
        const url = `${apiUrl}/assets/${id}?access_token=${authToken}`;
        return await download(url, filename_download);
      })).then(files => files.filter(file => file.status === 'fulfilled').map(file => {
        const fileParts = file.value.split('/');
        return fileParts[fileParts.length - 1];
      }));
      console.log("DIRECTUS: Assets download completed");
      console.log(uniqueArray(filesDownloaded));
    } catch (e) {
      console.error("DIRECTUS ERROR: Can not download assets", e);
      process.exit(1)
    }

    console.log("DIRECTUS: Loading done!");
    client.auth.logout();

  }
}

module.exports = DirectusSource
