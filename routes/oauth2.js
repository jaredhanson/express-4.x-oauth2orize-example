var createError = require('http-errors');
var express = require('express');
var oauth2orize = require('oauth2orize');
var passport = require('passport');
var HTTPBasicStrategy = require('passport-http').BasicStrategy;
var OAuth2ClientPasswordStrategy = require('passport-oauth2-client-password');
var async = require('async');
var url = require('url');
var qs = require('querystring');
var crypto = require('crypto');
var db = require('../db');


function verify(clientID, clientSecret, cb) {
  db.get('SELECT * FROM clients WHERE id = ?', [ clientID ], function(err, row) {
    if (err) { return next(err); }
    if (!row) { return cb(null, false); }
    if (!crypto.timingSafeEqual(Buffer.from(row.secret), Buffer.from(clientSecret))) {
      return cb(null, false);
    }
    var client = {
      id: row.id,
      name: row.name,
      redirectURI: row.redirect_uri
    };
    return cb(null, client);
  });
};

passport.use(new HTTPBasicStrategy(verify));
passport.use(new OAuth2ClientPasswordStrategy(verify));


var as = oauth2orize.createServer();

as.grant(oauth2orize.grant.code(function issue(client, redirectURI, user, ares, cb) {
  var grant = ares.grant;
  
  crypto.randomBytes(32, function(err, buffer) {
    if (err) { return cb(err); }
    var code = buffer.toString('base64');
    db.run('INSERT INTO authorization_codes (client_id, redirect_uri, user_id, grant_id, code) VALUES (?, ?, ?, ?, ?)', [
      client.id,
      redirectURI,
      user.id,
      grant.id,
      code
    ], function(err) {
      if (err) { return cb(err); }
      return cb(null, code);
    });
  });
}));

as.grant(oauth2orize.grant.token(function issue(client, user, ares, cb) {
  var grant = ares.grant;
  
  crypto.randomBytes(64, function(err, buffer) {
    if (err) { return cb(err); }
    var token = buffer.toString('base64');
    db.run('INSERT INTO access_tokens (user_id, client_id, token) VALUES (?, ?, ?)', [
      user.id,
      client.id,
      token,
    ], function(err) {
      if (err) { return cb(err); }
      return cb(null, token);
    });
  });
}));

as.exchange(oauth2orize.exchange.code(function issue(client, code, redirectURI, cb) {
  db.get('SELECT * FROM authorization_codes WHERE code = ?', [
    code
  ], function(err, row) {
    if (err) { return cb(err); }
    if (!row) { return cb(null, false); }
    
    crypto.randomBytes(64, function(err, buffer) {
      if (err) { return cb(err); }
      var token = buffer.toString('base64');
      db.run('INSERT INTO access_tokens (user_id, client_id, token) VALUES (?, ?, ?)', [
        row.user_id,
        row.client_id,
        token,
      ], function(err) {
        if (err) { return cb(err); }
        return cb(null, token);
      });
    });
  });
}));

as.serializeClient(function(client, cb) {
  process.nextTick(function() {
    cb(null, { id: client.id, type: client.type, name: client.name });
  });
});

as.deserializeClient(function(client, cb) {
  process.nextTick(function() {
    return cb(null, client);
  });
});


function evaluate(oauth2, cb) {
  console.log('** EVAL **');
  console.log(oauth2.client);
  console.log(oauth2.req);
  console.log(oauth2.locals);
  console.log(oauth2.info);
  oauth2.locals = oauth2.locals || {};
  
  async.waterfall([
    function login(next) {
      if (!oauth2.user) { return cb(null, false, oauth2.info, { prompt: 'login'} ); }
      next();
    },
    function allowed(next) {
      if (!oauth2.locals.grantID) { return next(); }
      
      db.get('SELECT * FROM grants WHERE id = ?', [ oauth2.locals.grantID ], function(err, row) {
        if (err) { return next(err); }
        if (!row) { return next(createError(400, 'Unknown grant "' + oauth2.locals.grantID + '"')); }
        if (row.user_id !== oauth2.user.id) { return next(createError(403, 'Unauthorized grant "' + row.id + '" for user')); }
        if (row.client_id !== oauth2.client.id) { return next(createError(403, 'Unauthorized grant "' + row.id + '" for client')); }
        
        var grant = {
          id: row.id,
          scope: oauth2.locals.scope
        };
        return cb(null, true, { grant: grant });
      });
    },
    function consent(next) {
      if (oauth2.client.type !== 'confidential') { return cb(null, false, oauth2.info, { prompt: 'consent'} ); }
      if (oauth2.req.type !== 'code') { return cb(null, false, oauth2.info, { prompt: 'consent'} ); }
      
      db.get('SELECT * FROM grants WHERE user_id = ? AND client_id = ?', [
        oauth2.user.id,
        oauth2.client.id
      ], function(err, row) {
        if (err) { return next(err); }
        if (!row) { return cb(null, false, oauth2.info, { prompt: 'consent' }); }
        var grant = {
          id: row.id,
          scope: row.scope ? row.scope.split(' ') : null
        };
        return cb(null, true, { grant: grant });
      });
    }
  ], function(err) {
    if (err) { return cb(err); }
    return cb(new Error('Internal authorization error'));
  });
}

function interact(req, res, next) {
  req.session.returnTo = url.resolve(req.originalUrl, 'continue?' +  qs.stringify({ transaction_id: req.oauth2.transactionID }));
  
  var prompt = req.oauth2.locals.prompt;
  var query = {};
  switch (prompt) {
  case 'login':
    return res.redirect('/login');
  case 'consent':
    query.client_id = req.oauth2.client.id;
    if (req.oauth2.req.scope) {
      query.scope = req.oauth2.req.scope.join(' ');
    }
    return res.redirect('/consent?' + qs.stringify(query));
  }
}


var router = express.Router();

router.get('/authorize',
  as.authorize(function validate(clientID, redirectURI, cb) {
    db.get('SELECT * FROM clients WHERE id = ?', [ clientID ], function(err, row) {
      if (err) { return cb(err); }
      if (!row) { return cb(createError(400, 'Unknown client "' + clientID + '"')); }
      var client = {
        id: row.id,
        type: row.secret ? 'confidential' : 'public',
        name: row.name,
        redirectURI: row.redirect_uri
      };
      if (client.redirectURI != redirectURI) { return cb(null, false); }
      return cb(null, client, client.redirectURI);
    });
  }, evaluate),
  interact,
  as.authorizationErrorHandler());

router.get('/continue',
  function(req, res, next) {
    res.locals.grantID = req.query.grant_id;
    res.locals.scope = req.query.scope && req.query.scope.split(' ');
    next();
  },
  as.resume(evaluate),
  interact,
  as.authorizationErrorHandler());

router.post('/token',
  passport.authenticate(['basic', 'oauth2-client-password'], { session: false }),
  as.token(),
  as.errorHandler());

module.exports = router;
