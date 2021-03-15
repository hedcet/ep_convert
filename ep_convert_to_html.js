const rateLimit = require("express-rate-limit");
const formidable = require('formidable');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const absolutePaths = require('ep_etherpad-lite/node/utils/AbsolutePaths');
const settings = require('ep_etherpad-lite/node/utils/Settings');

// const fsp_exists = util.promisify(fs.exists);
// const fsp_rename = util.promisify(fs.rename);
// const fsp_readFile = util.promisify(fs.readFile);
const fsp_unlink = util.promisify(fs.unlink);

let convertor = null;
let exportExtension = 'htm';

if (settings.abiword != null && settings.soffice === null) {
  convertor = require('ep_etherpad-lite/node/utils/Abiword');
}

if (settings.soffice != null) {
  convertor = require('ep_etherpad-lite/node/utils/LibreOffice');
  exportExtension = 'html';
}

let apikey = null;
const apikeyFile = absolutePaths.makeAbsolute("./APIKEY.txt");

try {
  apikey = fs.readFileSync(apikeyFile, "utf8");
} catch (e) {
  console.info(`apikey file(${apikeyFile}) not found`);
}

settings.importExportRateLimiting.onLimitReached = function (req, res, options) {
  console.warn(`ep_convert_to_html rate limiter triggered on ${req.originalUrl} for IP address ${req.ip}`);
}

const limiter = rateLimit(settings.importExportRateLimiting);

exports.expressCreateServer = function (hook_name, args, callback) {
  // handle convert to html requests
  args.app.post('/convert_to_html', async function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");

    if (req.query.apikey !== apikey.trim()) {
      res.statusCode = 401;
      return res.send({ code: 4, message: 'apikey not match', data: null });
    }

    if (!convertor) {
      res.statusCode = 404;
      return res.send({ code: 4, message: 'abiword/soffice not found', data: null });
    }

    const form = new formidable.IncomingForm();

    form.keepExtensions = true;
    form.maxFileSize = settings.importMaxFileSize;
    form.uploadDir = os.tmpdir();

    form.onPart = (part) => {
      form.handlePart(part);

      if (part.filename !== undefined) {
        form.openedFiles[form.openedFiles.length - 1]._writeStream.on('error', (e) => {
          form.emit('error', e);
        });
      }
    };

    const srcFile = await new Promise((resolve, reject) => {
      form.parse(req, (e, fields, files) => {
        if (e || !files.file) {
          if (e) {
            console.warn(`uploading error: ${e.stack}`);
          }

          if (e && e.stack && e.stack.indexOf('maxFileSize') !== -1) {
            return reject('exceed maxFileSize');
          }

          return reject('upload failed');
        }

        resolve(files.file.path);
      });
    });

    const fileEnding = path.extname(srcFile).toLowerCase();
    if (['.pdf', '.doc', '.docx', '.rtf', '.odt'].indexOf(fileEnding) < 0) {
      if (settings.allowUnknownFileEnds === true) {
        return res.download(srcFile)
      } else {
        console.warn('unknown file type', fileEnding);
        res.statusCode = 406;
        return res.send({ code: 4, message: 'unknown file type', data: null });
      }
    }

    const destFile = path.join(os.tmpdir(), `etherpad_convert_to_html_${Math.floor(Math.random() * 0xFFFFFFFF)}.${exportExtension}`);

    console.log('ep_convert_to_html', srcFile, destFile);

    await new Promise((resolve, reject) => {
      convertor.convertFile(srcFile, destFile, exportExtension, (e) => {
        if (e) {
          console.warn(`ep_convert_to_html error ${e}`);
          return reject('ep_convert_to_html failed');
        }

        resolve();
      });
    });

    setTimeout(async function () {
      await fsp_unlink(destFile);
    }, 1000 * 30);

    return res.download(destFile);
  });

  // apply rate limiter
  args.app.use('/convert_to_html', limiter);

  return callback();
}
