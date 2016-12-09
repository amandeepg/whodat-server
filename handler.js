var _ = require("lodash");
var request = require("request");
var Promise = require("bluebird");
var rgb2hex = require("rgb-hex");
var dateFormat = require("dateformat");
var AWS = require("aws-sdk");
AWS.config.setPromisesDependency(Promise);
var s3 = new AWS.S3();
Promise.promisifyAll(request);
var secondInMs = 1000;
var minuteInMs = secondInMs * 60;
var hourInMs = minuteInMs * 60;
var dayInMs = hourInMs * 24;
var weekInMs = dayInMs * 7;
var yearInMs = weekInMs * 52;
function getRequestOptions(url) {
    return {
        method: "GET",
        uri: process.env.BASE_URL + url,
        gzip: true,
        auth: {
            user: process.env.USER,
            pass: process.env.PASS
        }
    };
}
function normalizeKeys(key, value) {
    if (value && typeof value === "object") {
        for (var k in value) {
            if (/^[A-Z]/.test(k) && Object.hasOwnProperty.call(value, k)) {
                if (k === "ID") {
                    value["id"] = value[k];
                }
                else {
                    value[k.charAt(0).toLowerCase() + k.substring(1)] = value[k];
                }
                delete value[k];
            }
        }
    }
    return value;
}
function getTeamsPromise(league) {
    return request
        .getAsync(getRequestOptions(league + process.env.TEAMS_URL))
        .then(function (r) { return r.body; })
        .then(function (b) { return JSON.parse(b, normalizeKeys); })
        .then(function (j) { return j.overallteamstandings.teamstandingsentry; })
        .then(function (teams) { return teams.map(function (team) { return team.team; }); })
        .tap(function (teams) { return teams.forEach(function (team) { return team.league = league; }); });
}
function getGamesPromise(league, teams) {
    return request
        .getAsync(getRequestOptions(league + process.env.GAMES_URL))
        .then(function (r) { return r.body; })
        .then(function (b) { return JSON.parse(b, normalizeKeys); })
        .then(function (j) { return j.fullgameschedule.gameentry; })
        .tap(function (games) { return games.forEach(function (game) { return game.league = league; }); })
        .tap(function (games) { return games.forEach(function (game) {
        game.awayTeam = findTeam(teams, game.awayTeam);
        game.homeTeam = findTeam(teams, game.homeTeam);
    }); });
}
function getPlayersPromise(league, teams) {
    return request
        .getAsync(getRequestOptions(league + process.env.PLAYERS_URL))
        .then(function (r) { return r.body; })
        .then(function (b) { return JSON.parse(b, normalizeKeys); })
        .then(function (j) { return j.cumulativeplayerstats.playerstatsentry; })
        .tap(function (players) { return players.forEach(function (player) { return player.player.league = league; }); })
        .tap(function (players) { return players.forEach(function (player) {
        player.team = findTeam(teams, player.team);
        player.player.gamesPlayed = player.stats.gamesPlayed["#text"];
        delete player.stats;
    }); });
}
function extractHex(colourHash) {
    if (colourHash.hex) {
        return colourHash.hex[0];
    }
    else if (colourHash.rgb) {
        return rgb2hex.apply(null, colourHash.rgb[0].split(" ").map(function (s) { return parseInt(s); }));
    }
    else {
        console.log(colourHash);
        return null;
    }
}
function readAllDataFromApi() {
    var teamsFromApiPromise = Promise
        .all([
        getTeamsPromise("nhl"),
        getTeamsPromise("nba"),
        getTeamsPromise("nfl")
    ])
        .then(_.flatMap);
    var teamColoursPromise = s3
        .getObject({
        Bucket: "player-number",
        Key: "colors.json",
        ResponseContentType: "application/json"
    }).promise()
        .then(function (data) { return data.Body.toString(); })
        .then(JSON.parse);
    var teamsWithColorsPromise = Promise
        .all([
        teamsFromApiPromise,
        teamColoursPromise
    ])
        .spread(addColoursToTeams)
        .tap(function (teams) { return s3.putObject({
        Bucket: "player-number",
        Key: "teams.json",
        ContentType: "application/json",
        Body: JSON.stringify(teams)
    }).promise(); })
        .then(function (teams) {
        var gamesPromise = Promise
            .all([
            getGamesPromise("nhl", teams),
            getGamesPromise("nba", teams),
            getGamesPromise("nfl", teams)
        ])
            .then(_.flatMap)
            .tap(function (games) { return s3.putObject({
            Bucket: "player-number",
            Key: "games.json",
            ContentType: "application/json",
            Body: JSON.stringify(games)
        }).promise(); });
        var playersPromise = Promise
            .all([
            getPlayersPromise("nhl", teams),
            getPlayersPromise("nba", teams),
            getPlayersPromise("nfl", teams)
        ])
            .then(_.flatMap)
            .tap(function (players) { return s3.putObject({
            Bucket: "player-number",
            Key: "players.json",
            ContentType: "application/json",
            Body: JSON.stringify(players)
        }).promise(); });
        return Promise.all([gamesPromise, playersPromise]).then(function () { return teams; });
    });
}
function addColoursToTeams(teams, teamColours) {
    return teams.map(function (team) { return addColoursToTeam(team, teamColours); });
}
function addColoursToTeam(team, teamColours) {
    var teamName = team.city + " " + team.name;
    var teamColour = teamColours.find(function (teamColour) { return normalizeName(teamColour.name) === normalizeName(teamName); });
    if (teamColour) {
        team.colour = extractHex(teamColour.colors);
    }
    return team;
}
function normalizeName(name) {
    return name.replace(/\W+/g, " ");
}
function findTeam(teams, teamToFind) {
    return teams.find(function (team) { return team.id === teamToFind.id; });
}
module.exports.initData = readAllDataFromApi;
module.exports.teams = function (event, context, callback) {
    s3
        .getObject({
        Bucket: "player-number",
        Key: "teams.json",
        ResponseContentType: "application/json"
    }).promise()
        .then(function (data) { return data.Body.toString(); })
        .then(JSON.parse)
        .then(function (teams) { return callback(null, {
        statusCode: 200,
        headers: {
            "Expires": new Date(Date.now() + weekInMs).toUTCString()
        },
        body: JSON.stringify(teams)
    }); });
};
module.exports.players = function (event, context, callback) {
    if (!event.queryStringParameters) {
        callback(null, {
            statusCode: 200,
            headers: {
                "Expires": new Date(Date.now() + yearInMs).toUTCString()
            },
            body: JSON.stringify([])
        });
        return;
    }
    var team1 = event.queryStringParameters.team;
    if (!team1) {
        callback(null, {
            statusCode: 200,
            headers: {
                "Expires": new Date(Date.now() + yearInMs).toUTCString()
            },
            body: JSON.stringify([])
        });
        return;
    }
    s3
        .getObject({
        Bucket: "player-number",
        Key: "players.json",
        ResponseContentType: "application/json"
    }).promise()
        .then(function (data) { return data.Body.toString(); })
        .then(JSON.parse)
        .then(function (players) { return callback(null, {
        statusCode: 200,
        headers: {
            "Expires": new Date(Date.now() + dayInMs).toUTCString()
        },
        body: JSON.stringify(players.filter(function (player) { return player.team.id === team1; }))
    }); });
};
module.exports.games = function (event, context, callback) {
    // Convert to PST, place of last games of the day in North America
    var pstOffset = hourInMs * 8;
    var date = new Date(Date.now() - pstOffset);
    var today = dateFormat(date, "yyyy-mm-dd");
    s3
        .getObject({
        Bucket: "player-number",
        Key: "games.json",
        ResponseContentType: "application/json"
    }).promise()
        .then(function (data) { return data.Body.toString(); })
        .then(JSON.parse)
        .then(function (games) { return callback(null, {
        statusCode: 200,
        headers: {
            Expires: new Date(new Date().setHours(23, 59, 59, 999) + pstOffset).toUTCString()
        },
        body: JSON.stringify(games.filter(function (game) { return game.date === today; }))
    }); });
};
