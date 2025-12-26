const path = require('path');
const fs = require('fs');
const express = require('express');
const decode = require('safe-decode-uri-component');
const { cookieToJson } = require('../util/util');
const { createRequest } = require('../util/request');

let app = null;

async function getModulesDefinitions(modulesPath) {
  const files = fs.readdirSync(modulesPath);
  return files
    .reverse()
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('_'))
    .map((fileName) => {
      const route = `/${fileName.replace(/\.js$/i, '').replace(/_/g, '/')}`;
      const modulePath = path.resolve(modulesPath, fileName);
      const module = require(modulePath);
      return { route, module };
    });
}

async function createApp() {
  if (app) return app;
  
  app = express();
  app.set('trust proxy', true);

  // CORS
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'Authorization,X-Requested-With,Content-Type,Cache-Control',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next();
  });

  // Cookie Parser
  app.use((req, _, next) => {
    req.cookies = {};
    (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      const crack = pair.indexOf('=');
      if (crack < 1 || crack === pair.length - 1) return;
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(pair.slice(crack + 1)).trim();
    });
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, '../public')));

  const moduleDefinitions = await getModulesDefinitions(path.join(__dirname, '../module'));

  for (const moduleDef of moduleDefinitions) {
    app.use(moduleDef.route, async (req, res) => {
      [req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie));
        }
      });

      const query = Object.assign({}, { cookie: req.cookies }, req.query, { body: req.body });
      try {
        const moduleResponse = await moduleDef.module(query, (config) => {
          let ip = req.ip;
          if (ip && ip.substring(0, 7) === '::ffff:') ip = ip.substring(7);
          config.ip = ip;
          return createRequest(config);
        });

        const cookies = moduleResponse.cookie;
        if (!query.noCookie && Array.isArray(cookies) && cookies.length > 0) {
          res.append('Set-Cookie', cookies.map((cookie) => `${cookie}; PATH=/; SameSite=None; Secure`));
        }
        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      } catch (e) {
        res.status(e.status || 500).send(e.body || { code: 500, msg: 'Error' });
      }
    });
  }

  return app;
}

module.exports = async (req, res) => {
  const expressApp = await createApp();
  return expressApp(req, res);
};
