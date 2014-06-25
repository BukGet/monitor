var restify = require('restify');
var unirest = require('unirest');
var stats = { 'status' : 'pending', 'servers' : {} };
var postmark = require('postmark')(process.env.POSTMARK_API_KEY)

var Status = {
  servers: [
    'chicago.api.bukget.org', 
    'paris.api.bukget.org'
  ],

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

	unirest.get(url).headers({ 'User-Agent': 'BukGet-Monitor' }).timeout(20000).end(function (response) {
		if (response.error) {
			return callback(false, response.error);
		}

		return callback(true);
	});
};

Status.check = function () {
  for (var server in Status.servers) {
  	(function request (server) {
		  for (var version in Status.versions) {
		    (function request (version) {
		      var sections = Status.versions[version];
		      var errors = 0;
		      var called = 0;
		      var length = Object.keys(sections).length;

		      for (var section in sections) {
		        (function request (section) {
		          var path = sections[section];

		          return Status.call(server, path, function (status, error) {
		            called++;
		            errors += (error == 'ETIMEDOUT' || !status ? 1 : 0);
		            stats['servers'][server][version][section] = (error == 'ETIMEDOUT' ? 'warning' : (status ? 'ok' : 'down'));
		            if (called === length && version === 'v3') {
		              var status = 'ok';

		              if (errors > 3) {
		                status = 'down';
		              } else if (errors) {
		                status = 'warning';
		              }

		              if (stats.status != 'down' && status == 'down') {
			              stats.status = status;
			              Status.sendEmail('BukGet is down!', JSON.stringify(stats));
		              } else if (stats.status == 'down' && status == 'up') {
		              	stats.status = status;
		              	Status.sendEmail('BukGet is back up!', JSON.stringify(stats));
		              }

		              stats.status = status;
		            }

		            return;
		          });
		        })(section);
		      }
		    })(version);
		  }
		})(Status.servers[server]);
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
	stats['servers'][Status.servers[server]] = {};
	for (var version in Status.versions) {
		stats['servers'][Status.servers[server]][version] = {};
		for (var section in Status.versions[version]) {
			stats['servers'][Status.servers[server]][version][section] = 'pending';
		}
	}
}

Status.check();

setInterval(function() {
	Status.check();
}, 1000 * 60);

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

app.listen(process.env.PORT || 5000);