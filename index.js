var restify = require('restify');
var unirest = require('unirest');
var cloudflare = require('cloudflare').createClient({ email: process.env.CLOUDFLARE_EMAIL, token: process.env.CLOUDFLARE_API_KEY });
var nodemailer = require('nodemailer');
var smtpTransport = require('nodemailer-smtp-transport');
var async = require('async');
var config = require('./config');
var transporter = nodemailer.createTransport(smtpTransport({
  host: 'smtp.mandrillapp.com',
  port: 587,
  auth: {
    user: process.env.MANDRILL_USER,
    pass: process.env.MANDRILL_PASS
  }
}));

var stats = { 'status' : 'pending', 'servers' : {} };
var started = false;
var lastSerial = 0;
var serialRevision = 1;
var currentlyChecking = false;
var checks = [];

var Status = {};

Status.setupChecks = function () {
  for (var server in config.servers) {
    var the_server = config.servers[server];
    for (var version in config.versions) {
      var the_version = config.versions[version];
      for (var section in the_version) {
        checks.push({ 'server': server, 'host': the_server.ip, 'version': version, 'section': section, 'path': the_version[section]});
      }
    }
  }
}

Status.call = function (server, uri, callback) {
  var url = 'http://' + server + uri;

  unirest.get(url).headers({ 'User-Agent': 'BukGet-Monitor' }).timeout(5000).end(function (response) {
    if (response.error) {
      return callback(false, response.error);
    }

    return callback(true);
  });
};

Status.check = function () {
  console.log('Running checks');
  currentlyChecking = true;
  var currentCheckResults = [];
  async.eachSeries(checks, function (check, callback) {
    Status.call(check.host, check.path, function (status, error) {
      currentCheckResults.push({ 'server': check.server, 'section': check.section, 'version': check.version, 'status': (error == 'ETIMEDOUT' ? 'warning' : (status ? 'ok' : 'down')) });
      callback();
    });
  }, function (err) {
    if (err) {
      console.log('Error when checking status: ');
      console.trace(err);
    } else {
      console.log('Checks successfully executed');
    }
    var totalErrors = 0;
    for (var i in currentCheckResults) {
      var checkResult = currentCheckResults[i];
      if (checkResult.status == 'down') {
        totalErrors++;
      }
      stats.servers[checkResult.server][checkResult.version][checkResult.section] = checkResult.status;
    }
    var the_status = 'ok';
    if (totalErrors > 3) {
      the_status = 'down';
    } else if (totalErrors > 0) {
      the_status = 'warning';
    }

    currentlyChecking = false;

    var doRefresh = false;

    if (stats.status !== 'down' && the_status === 'down') {
      stats.status = the_status;
      Status.sendEmail('BukGet is down!', JSON.stringify(stats));
      doRefresh = true;
    } else if (stats.status === 'down' && the_status === 'ok') {
      stats.status = the_status;
      Status.sendEmail('BukGet is back up!', JSON.stringify(stats));
      doRefresh = true;
    } else {
      stats.status = the_status;
    }

    if (!started) {
      started = true;
      if (!doRefresh) {
        console.log('Checking initial DNS consistency');
        Status.checkDnsConsistency();
      }
    }

    if (doRefresh) {
      console.log('Refreshing DNS for state: %s', stats.status);
      Status.dnsRefresh();
    }
    setTimeout(function () {
      Status.check();
    }, 1000 * 60);
  });
};

Status.sendEmail = function (title, body) {
  transporter.sendMail({
    from: 'BukGet Monitor <staff@bukget.org>',
    to: 'staff@bukget.org',
    subject: title,
    text: body
  });
};

for (var server in config.servers) {
  stats['servers'][server] = {};
  for (var version in config.versions) {
    stats['servers'][server][version] = {};
    for (var section in config.versions[version]) {
      stats['servers'][server][version][section] = 'pending';
    }
  }
}

Status.updateSerial = function (callback) {
  var now = new Date();
  var newSerial = now.getFullYear() + '' + ('0' + (now.getMonth() + 1)).slice(-2) + ('0' + now.getDate()).slice(-2);
  if (lastSerial != newSerial) {
    serialRevision = 1;
    lastSerial = newSerial;
  }
}

Status.dnsRefresh = function () {
  Status.updateSerial();
  serialRevision++;
  if (serialRevision > 99) {
    serialRevision = 1;
  }

  Status.dnsGetServers(function (callback) {
    Status.updateCloudflare(callback);
    Status.dnsRefreshServers(callback);
  });
}

Status.dnsGetServers = function (callback) {
  var servers = [];
  for (var server in stats['servers']) {
    var downCount = 0;
    for (var i in stats['servers'][server]['v3']) {
      if (stats['servers'][server]['v3'][i] == 'down') {
        downCount++;
      }
    }

    if (downCount == 0) {
      servers.push({ 'name': server, 'ns': server + '.ns.bukget.org', 'api': server + '.api.bukget.org', 'ip': config.servers[server]['ip'], 'region': config.servers[server]['region'] });
    }
  }
  callback(servers);
}

Status.dnsRefreshServers = function (servers) {
  for (var server in config.servers) {
    Status.dnsRefreshServer(server, servers);
  }
}

Status.dnsRefreshServer = function (server, servers) {
  console.log('Updating dns for %s', server);
  unirest.post('http://' + server + '.ns.bukget.org/dnsupdate')
  .headers({ 'Accept': 'application/json' })
  .send({ 'key': process.env.DNS_CHANGER, 'servers': JSON.stringify(servers), 'serial': (lastSerial + '' + ('0' + serialRevision).slice(-2)) })
  .end(function (response) {
    if (response.error || response.code == 500) {
      if (response.error) {
        console.log('Error updating DNS: ');
        console.trace(response.error);
      }
      console.log('Couldn\'t update DNS for %s', server);
    } else {
      console.log('Successfully updated DNS for %s', server);
    }
  });
}

Status.updateCloudflare = function (callback) {
  var toBeAdded = []
  for (var i in callback) {
    toBeAdded.push(callback[i]['ns']);
  }
  cloudflare.listDomainRecords('bukget.org', function (err, domains) {
    if (err) throw err;
    for (var i in domains) {
      var item = domains[i];
      if (item['type'] == 'NS') {
        var exists = false;
        var name = item['content'].split('.')[0];
        for (var server in callback) {
          if (callback[server]['name'] == name) {
            exists = true;
          }
        }
        if (!exists) {
          console.log('Delecting record for %s', item['content']);
          cloudflare.deleteDomainRecord('bukget.org', item['rec_id'], function (err, success) {
            console.log('Deleted record');
          })
        } else {
          var index = toBeAdded.indexOf(item['content']);
          if (index !== -1) {
            toBeAdded.splice(index, 1);
          }
        }
      }
    }
    for (var record in toBeAdded) {
      console.log('Adding record for %s', toBeAdded[record]);
      cloudflare.addDomainRecord('bukget.org', { 'type': 'NS', 'name': 'api', 'content': toBeAdded[record], 'ttl': 300 }, function (err, success) {
        console.log('Added record!');
      });
    }
  });
}

Status.checkDnsConsistency = function () {
  if (currentlyChecking) {
    setTimeout(function () {
      Status.checkDnsConsistency();
    }, 1000 * 20);
    return;
  }
  Status.dnsGetServers(function (callback) {
    Status.updateCloudflare(callback);
    for (var server in config.servers) {
      (function request (server) {  
        return Status.needsUpdate(server, function (status, error) {
          if (error) {
            console.log('Couldn\'t get current serial for %s', server);
          }

          if (status) {
            Status.dnsRefreshServer(server, callback);
          }
        })
      })(server); 
    }
  });
}

Status.needsUpdate = function (server, callback) {
  unirest.get('http://' + server + '.ns.bukget.org/serial').end(function (response) {
    if (response.error) {
      return callback(false, 'Couldn\'t get serial');
    }

    if (response.body['serial'] != (lastSerial + '' + ('0' + serialRevision).slice(-2))) {
      return callback(true);
    }

    return callback(false);
  });
}

Status.setupChecks();

Status.updateSerial();

Status.check();

setInterval(function () {
  Status.checkDnsConsistency();
}, 1000 * 60 * 30);

setInterval(function () {
  unirest.get('http://monitor.bukget.org').end(function (response) {});
}, 1000 * 60 * 20);

var app = restify.createServer();

app.use(restify.jsonp());

app.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', function (req, res, next) {
  res.send(stats);
});

app.get('/currentDNS', function (req, res, next) {
  Status.dnsGetServers(function (callback) {
    res.send({ 'serial': (lastSerial + '' + ('0' + serialRevision).slice(-2)), 'servers': callback })
  });
})

Status.sendEmail('BukGet monitor has started!', 'It has indeed');

app.listen(process.env.OPENSHIFT_NODEJS_PORT || 5000, process.env.OPENSHIFT_NODEJS_IP || '0.0.0.0');