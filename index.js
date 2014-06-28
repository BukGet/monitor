var restify = require('restify');
var unirest = require('unirest');
var stats = { 'status' : 'pending', 'servers' : {} };
var postmark = require('postmark')(process.env.POSTMARK_API_KEY);
var cloudflare = require('cloudflare').createClient({ email: process.env.CLOUDFLARE_EMAIL, token: process.env.CLOUDFLARE_API_KEY });

var started = false;
var lastSerial = 0;
var serialRevision = 1;

var Status = {
  servers: {
  	'ca' : { 'ip': '192.155.97.86', 'region': 'us', 'down': false },
    'ny' : { 'ip': '192.227.140.113', 'region': 'us', 'down': false },
    'de' : { 'ip': '5.62.103.8', 'region': 'europe', 'down': false },
    'fr' : { 'ip': '176.31.222.122', 'region': 'europe', 'down': false }
  },

  versions: {
    'v3': {
      'pl': '/3/plugins',
      'plb': '/3/plugins/bukkit',
      'pd': '/3/plugins/bukkit/pvp-arena',
      'pdl': '/3/plugins/bukkit/pvp-arena/latest',
      'pdr': '/3/plugins/bukkit/pvp-arena/release',
      'pdb': '/3/plugins/bukkit/pvp-arena/beta',
      'pda': '/3/plugins/bukkit/pvp-arena/alpha',
      'cl': '/3/categories',
      'cpl': '/3/categories/Admin Tools',
      'al': '/3/authors',
      'apl': '/3/authors/NuclearW',
      'upd': '/3/updates?slug=dynmap',
      'se': '/3/search/versions.type/=/Alpha?sort=-popularity.daily',
    }
  }
};

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
  var serverCount = Object.keys(Status.servers).length;
  var doneCount = 0;
  var totalErrors = 0;
  var doRefresh = false;
  for (var server in Status.servers) {
  	(function request (server) {
		  for (var version in Status.versions) {
		    (function request (version) {
		    	var errors = 0;
		      var sections = Status.versions[version];
		      var called = 0;
		      var length = Object.keys(sections).length;

		      for (var section in sections) {
		        (function request (section) {
		          var path = sections[section];

		          return Status.call(Status.servers[server]['ip'], path, function (status, error) {
		            called++;
		            errors += (error == 'ETIMEDOUT' || !status ? 1 : 0);
		            totalErrors += (error == 'ETIMEDOUT' || !status ? 1 : 0);
		            stats['servers'][server][version][section] = (error == 'ETIMEDOUT' ? 'warning' : (status ? 'ok' : 'down'));
		            if (called === length && version === 'v3') {
		            	if (errors > 3 && !Status.servers[server]['down']) {
		            		Status.servers[server]['down'] = true;
		            		doRefresh = true;
		            	} else if (errors < 3 && Status.servers[server]['down']) {
		            		Status.servers[server]['down'] = false;
		            		doRefresh = true;
		            	}
		              doneCount++;
		              if (doneCount >= serverCount) {
			              var the_status = 'ok';

			              if (totalErrors > 3) {
			                the_status = 'down';
			              } else if (totalErrors) {
			                the_status = 'warning';
			              }

			              if (stats.status != 'down' && the_status == 'down') {
			              	stats.status = the_status;
	              			Status.sendEmail('BukGet is down!', JSON.stringify(stats));
	              			doRefresh = true;
			              } else if (stats.status == 'down' && the_status == 'ok') {
			              	stats.status = the_status;
			              	Status.sendEmail('BukGet is back up!', JSON.stringify(stats));
			              	doRefresh = true;
			              } else {
			              	stats.status = the_status;
				            	if (!started) {
			            			started = true;
												Status.checkDnsConsistency();
			            		}
			            	}

			              if (doRefresh) {
			            		Status.dnsRefresh();
			              }
		              }
		            }

		            return;
		          });
		        })(section);
		      }
		    })(version);
		  }
		})(server);
	}

  return;
};

Status.sendEmail = function (title, body) {
	postmark.send({
	    'From': 'staff@bukget.org',
	    'To': 'staff@bukget.org',
	    'Subject': title,
	    'TextBody': body
	}, function(error, success) {
	    if(error) {
	        console.error('Unable to send via postmark: ' + error.message);
	       return;
	    }
	    console.info('Sent to postmark for delivery')
	});
};

for (var server in Status.servers) {
	stats['servers'][server] = {};
	for (var version in Status.versions) {
		stats['servers'][server][version] = {};
		for (var section in Status.versions[version]) {
			stats['servers'][server][version][section] = 'pending';
		}
	}
}

Status.updateSerial = function(callback) {
	var now = new Date();
	var newSerial = now.getFullYear() + "" + ("0" + (now.getMonth() + 1)).slice(-2) + ("0" + now.getDate()).slice(-2);
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
  console.log("Updated DNS");
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
			servers.push({ 'name': server, 'ns': server + '.ns.bukget.org', 'api': server + '.api.bukget.org', 'ip': Status.servers[server]['ip'], 'region': Status.servers[server]['region'] });
		}
  }
  callback(servers);
}

Status.dnsRefreshServers = function (servers) {
	for (var server in Status.servers) {
		Status.dnsRefreshServer(server, servers);
	}
}

Status.dnsRefreshServer = function (server, servers) {
	console.log("Updating dns for " + server);
	unirest.post('http://' + server + '.ns.bukget.org/dnsupdate')
	.headers({ 'Accept': 'application/json' })
	.send({ "key": process.env.DNS_CHANGER, "servers": JSON.stringify(servers), "serial": (lastSerial + "" + ("0" + serialRevision).slice(-2)) })
	.end(function (response) {
		if (response.error) {
			console.log(response.error);
			console.log("Couldn't update DNS for " + server);
		}
	});
}

Status.updateCloudflare = function(callback) {
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
					cloudflare.deleteDomainRecord('bukget.org', item['rec_id'], function(err, success) {
						console.log("Deleted record");
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
			cloudflare.addDomainRecord('bukget.org', { 'type': 'NS', 'name': 'api', 'content': toBeAdded[record], 'ttl': 300 }, function (err, success) {
				console.log("Added record!");
			});
		}
	});
}

Status.checkDnsConsistency = function () {
		Status.dnsGetServers(function (callback) {
 			Status.updateCloudflare(callback);
		  for (var server in Status.servers) {
		  	(function request (server) {	
	        return Status.needsUpdate(server, function (status, error) {
		  			if(error) {
					      console.log('Couldn\'t get current serial for ' + server);
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

	    if (response.body['serial'] != (lastSerial + "" + ("0" + serialRevision).slice(-2))) {
	    	return callback(true);
	    }

	    return callback(false);
	});
}

Status.updateSerial();

Status.check();

setInterval(function() {
	Status.check();
}, 1000 * 60);

setInterval(function() {
	Status.checkDnsConsistency();
}, 1000 * 60 * 60);

setInterval(function() {
	unirest.get('http://bukget-monitor.herokuapp.com').end(function (response) {});
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
		res.send({ 'serial': (lastSerial + "" + ("0" + serialRevision).slice(-2)), 'servers': callback })
	});
})

app.listen(process.env.PORT || 5000);