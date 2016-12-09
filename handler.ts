const _ = require("lodash")
const request = require("request")
const Promise = require("bluebird")
const rgb2hex = require("rgb-hex")
const dateFormat = require("dateformat")
const AWS = require("aws-sdk")
AWS.config.setPromisesDependency(Promise)
var s3 = new AWS.S3()
Promise.promisifyAll(request)

const secondInMs = 1000
const minuteInMs = secondInMs * 60
const hourInMs = minuteInMs * 60
const dayInMs = hourInMs * 24
const weekInMs = dayInMs * 7
const yearInMs = weekInMs * 52

interface IHeaderExpires {
    Expires: string; 
}

interface IResponsePayload {  
    statusCode: number
    headers: IHeaderExpires
    body: string
}

interface IQueryParameters {  
    team: string
}

interface IEventPayload {  
    method: string
    queryStringParameters: IQueryParameters
}

interface ICallback {  
    (error: any, result: IResponsePayload): void
}

interface IColor {
    hex: Array<string>
    rgb: Array<string>
}

function getRequestOptions(url: string) {
    return {
        method: "GET",
        uri: process.env.BASE_URL + url,
        gzip: true,
        auth: {
            user: process.env.USER,
            pass: process.env.PASS
        }
    }
}

function normalizeKeys(key, value) {
    if (value && typeof value === "object") {
        for (var k in value) {
            if (/^[A-Z]/.test(k) && Object.hasOwnProperty.call(value, k)) {
                if (k === "ID") {
                    value["id"] = value[k]
                } else {
                    value[k.charAt(0).toLowerCase() + k.substring(1)] = value[k]
                }
                delete value[k]
            }
        }
    }
    return value
}

function getTeamsPromise(league: string) {
    return request
        .getAsync(getRequestOptions(league + process.env.TEAMS_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.overallteamstandings.teamstandingsentry)
        .then(teams => teams.map(team => team.team))
        .tap(teams => teams.forEach(team => team.league = league))
}

function getGamesPromise(league:string, teams) {
    return request
        .getAsync(getRequestOptions(league + process.env.GAMES_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.fullgameschedule.gameentry)
        .tap(games => games.forEach(game => game.league = league))
        .tap(games => games.forEach(game => {
            game.awayTeam = findTeam(teams, game.awayTeam)
            game.homeTeam = findTeam(teams, game.homeTeam)
        }))
}

function getPlayersPromise(league: string, teams) {
    return request
        .getAsync(getRequestOptions(league + process.env.PLAYERS_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.cumulativeplayerstats.playerstatsentry)
        .tap(players => players.forEach(player => player.player.league = league))
        .tap(players => players.forEach(player => {
            player.team = findTeam(teams, player.team)
            player.player.gamesPlayed = player.stats.gamesPlayed["#text"]
            delete player.stats
        }))
}

function extractHex(colourHash: IColor) {
    if (colourHash.hex) {
        return colourHash.hex[0]
    } else if (colourHash.rgb) {
        return rgb2hex.apply(null, colourHash.rgb[0].split(" ").map(s => parseInt(s)))
    } else {
        console.log(colourHash)
        return null
    }
}

function readAllDataFromApi() {
    var teamsFromApiPromise = Promise
        .all([
            getTeamsPromise("nhl"),
            getTeamsPromise("nba"),
            getTeamsPromise("nfl")
        ])
        .then(_.flatMap)

    var teamColoursPromise = s3
        .getObject({
            Bucket: "player-number",
            Key: "colors.json",
            ResponseContentType :"application/json"
        }).promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
    var teamsWithColorsPromise = Promise
        .all([
            teamsFromApiPromise,
            teamColoursPromise
        ])
        .spread(addColoursToTeams)
        .tap(teams => s3.putObject({
            Bucket: "player-number",
            Key: "teams.json",
            ContentType :"application/json",
            Body: JSON.stringify(teams)
        }).promise())
        .then(teams => {
            var gamesPromise = Promise
                .all([
                    getGamesPromise("nhl", teams),
                    getGamesPromise("nba", teams),
                    getGamesPromise("nfl", teams)
                ])
                .then(_.flatMap)
                .tap(games => s3.putObject({
                    Bucket: "player-number",
                    Key: "games.json",
                    ContentType :"application/json",
                    Body: JSON.stringify(games)
                }).promise())
            var playersPromise = Promise
                .all([
                    getPlayersPromise("nhl", teams),
                    getPlayersPromise("nba", teams),
                    getPlayersPromise("nfl", teams)
                ])
                .then(_.flatMap)
                .tap(players => s3.putObject({
                    Bucket: "player-number",
                    Key: "players.json",
                    ContentType :"application/json",
                    Body: JSON.stringify(players)
                }).promise())
            return Promise.all([gamesPromise, playersPromise]).then(() => teams)
        })
}

function addColoursToTeams(teams, teamColours) {
    return teams.map(team => addColoursToTeam(team, teamColours))
}

function addColoursToTeam(team, teamColours) {
    var teamName = team.city + " " + team.name
    var teamColour = teamColours.find(teamColour => normalizeName(teamColour.name) === normalizeName(teamName))
    if (teamColour) {
        team.colour = extractHex(teamColour.colors)
    }
    return team
}

function normalizeName(name) {
    return name.replace(/\W+/g, " ")
}

function findTeam(teams, teamToFind) {
    return teams.find(team => team.id === teamToFind.id)
}

module.exports.initData = readAllDataFromApi

module.exports.teams = (event: IEventPayload, context, callback: ICallback) => {
    s3
        .getObject({
            Bucket: "player-number",
            Key: "teams.json",
            ResponseContentType :"application/json"
        }).promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
        .then(teams => callback(null, {
            statusCode: 200,
            headers: {
                "Expires": new Date(Date.now() + weekInMs).toUTCString()
            },
            body: JSON.stringify(teams)
        }))
}

module.exports.players = (event: IEventPayload, context, callback: ICallback) => {
    if (!event.queryStringParameters) {
        callback(null, {
            statusCode: 200,
            headers: {
                "Expires": new Date(Date.now() + yearInMs).toUTCString()
            },
            body: JSON.stringify([])
        })
        return
    }

    var team1 = event.queryStringParameters.team

    if (!team1) {
        callback(null, {
            statusCode: 200,
            headers: {
                "Expires": new Date(Date.now() + yearInMs).toUTCString()
            },
            body: JSON.stringify([])
        })
        return
    }

    s3
        .getObject({
            Bucket: "player-number",
            Key: "players.json",
            ResponseContentType :"application/json"
        }).promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
        .then(players => callback(null, {
            statusCode: 200,
            headers: {
                "Expires": new Date(Date.now() + dayInMs).toUTCString()
            },
            body: JSON.stringify(players.filter(player => player.team.id === team1))
        }))
}

module.exports.games = (event: IEventPayload, context, callback: ICallback) => {
    // Convert to PST, place of last games of the day in North America
    var pstOffset = hourInMs * 8
    var date = new Date(Date.now() - pstOffset)
    var today = dateFormat(date, "yyyy-mm-dd")

    s3
        .getObject({
            Bucket: "player-number",
            Key: "games.json",
            ResponseContentType :"application/json"
        }).promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
        .then(games => callback(null, {
            statusCode: 200,
            headers: {
                "Expires": new Date(new Date().setHours(23, 59, 59, 999) + pstOffset).toUTCString()
            },
            body: JSON.stringify(games.filter(game => game.date === today))
        }))
}
