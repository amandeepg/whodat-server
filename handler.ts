import _ = require("lodash")
import request = require("request")
import Promise = require("bluebird")
import rgb2hex = require("rgb-hex")
import dateFormat = require("dateformat")
import AWS = require("aws-sdk")
AWS.config.setPromisesDependency(Promise)
var s3 = new AWS.S3()
Promise.promisifyAll(request)

const secondInMs: number = 1000
const minuteInMs: number = secondInMs * 60
const hourInMs: number = minuteInMs * 60
const dayInMs: number = hourInMs * 24
const weekInMs: number = dayInMs * 7
const yearInMs: number = weekInMs * 52

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
    hex?: Array<string>
    rgb?: Array<string>
}

interface ITeamColor {
    name: string
    league: string
    colors: IColor
}

interface ITeam {
    abbreviation: string
    city: string
    colour: string
    id: string
    league: string
    name: string
}

interface IGame {
    awayTeam: ITeam
    homeTeam: ITeam
    date: string
    league: string
    location: string
    time: string
}

interface IPlayerTeam {
    player: IPlayer
    team: ITeam
    stats?: any
}

interface IPlayer {
    age: string
    birthCity: string
    birthCountry: string      
    birthDate: string
    firstName: string
    gamesPlayed: string
    height: string
    id: string
    isRookie: string
    jerseyNumber: string
    lastName: string
    league: string
    position: string
    weight: string
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

function normalizeKeys(key: string, value: any) {
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

function getTeamsPromise(league: string): Promise<Array<ITeam>> {
    return request
        .getAsync(getRequestOptions(league + process.env.TEAMS_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.overallteamstandings.teamstandingsentry)
        .then((teams: Array<IPlayerTeam>) => teams.map((team: IPlayerTeam) => team.team))
        .tap((teams: Array<ITeam>) => teams.forEach((team: ITeam) => team.league = league))
}

function getGamesPromise(league:string, teams: Array<ITeam>): Promise<Array<IGame>> {
    return request
        .getAsync(getRequestOptions(league + process.env.GAMES_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.fullgameschedule.gameentry)
        .tap((games: Array<IGame>) => games.forEach((game: IGame) => game.league = league))
        .tap((games: Array<IGame>) => games.forEach((game: IGame) => {
            game.awayTeam = findTeam(teams, game.awayTeam)
            game.homeTeam = findTeam(teams, game.homeTeam)
        }))
}

function getPlayersPromise(league: string, teams: Array<ITeam>): Promise<Array<IPlayerTeam>> {
    return request
        .getAsync(getRequestOptions(league + process.env.PLAYERS_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.cumulativeplayerstats.playerstatsentry)
        .tap((players: Array<IPlayerTeam>) => players.forEach((player: IPlayerTeam) => player.player.league = league))
        .tap((players: Array<IPlayerTeam>) => players.forEach((player: IPlayerTeam) => {
            player.team = findTeam(teams, player.team)
            player.player.gamesPlayed = player.stats.gamesPlayed["#text"]
            delete player.stats
        }))
}

function extractHex(colourHash: IColor): string {
    if (colourHash.hex) {
        return colourHash.hex[0]
    } else if (colourHash.rgb) {
        return rgb2hex.apply(null, colourHash.rgb[0].split(" ").map(s => parseInt(s)))
    } else {
        console.log(colourHash)
        return null
    }
}

function readAllDataFromApi(): void {
    var teamsFromApiPromise: Promise.Thenable<Array<ITeam>> = Promise
        .all([
            getTeamsPromise("nhl"),
            getTeamsPromise("nba"),
            getTeamsPromise("nfl")
        ])
        .then(_.flatMap)

    var teamColoursPromise: Promise.Thenable<Array<ITeamColor>> = s3
        .getObject({
            Bucket: "player-number",
            Key: "colors.json",
            ResponseContentType :"application/json"
        })
        .promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)

    var teamsWithColorsPromise = Promise
        .all([
            teamsFromApiPromise,
            teamColoursPromise
        ])
        .spread(addColoursToTeams)
        .tap((teams: Array<ITeam>) => s3.putObject({
            Bucket: "player-number",
            Key: "teams.json",
            ContentType :"application/json",
            Body: JSON.stringify(teams)
        }).promise())
        .then((teams: Array<ITeam>) => {
            var gamesPromise = Promise
                .all([
                    getGamesPromise("nhl", teams),
                    getGamesPromise("nba", teams),
                    getGamesPromise("nfl", teams)
                ])
                .then(_.flatMap)
                .tap((games: Array<IGame>) => s3.putObject({
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
                .tap((players: Array<IPlayerTeam>) => s3.putObject({
                    Bucket: "player-number",
                    Key: "players.json",
                    ContentType :"application/json",
                    Body: JSON.stringify(players)
                }).promise())
            return Promise.all([gamesPromise, playersPromise]).then(() => teams)
        })
}

function addColoursToTeams(teams: Array<ITeam>, teamColours): Array<ITeam> {
    return teams.map(team => addColoursToTeam(team, teamColours))
}

function addColoursToTeam(team: ITeam, teamColours): ITeam {
    var teamName = team.city + " " + team.name
    var teamColour = teamColours.find(teamColour => normalizeName(teamColour.name) === normalizeName(teamName))
    if (teamColour) {
        team.colour = extractHex(teamColour.colors)
    }
    return team
}

function normalizeName(name: string): string {
    return name.replace(/\W+/g, " ")
}

function findTeam(teams: Array<ITeam>, teamToFind: ITeam): ITeam {
    return teams.find(team => team.id === teamToFind.id)
}

module.exports.initData = readAllDataFromApi

module.exports.teams = (event: IEventPayload, context, callback: ICallback): void => {
    s3
        .getObject({
            Bucket: "player-number",
            Key: "teams.json",
            ResponseContentType :"application/json"
        }).promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
        .then((teams: Array<ITeam>) => callback(null, {
            statusCode: 200,
            headers: {
                Expires: new Date(Date.now() + weekInMs).toUTCString()
            },
            body: JSON.stringify(teams)
        }))
}

module.exports.players = (event: IEventPayload, context, callback: ICallback): void => {
    if (!event.queryStringParameters) {
        callback(null, {
            statusCode: 200,
            headers: {
                Expires: new Date(Date.now() + yearInMs).toUTCString()
            },
            body: JSON.stringify([])
        })
        return
    }

    var teamId: string = event.queryStringParameters.team

    if (!teamId) {
        callback(null, {
            statusCode: 200,
            headers: {
                Expires: new Date(Date.now() + yearInMs).toUTCString()
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
        .then((players: Array<IPlayerTeam>) => callback(null, {
            statusCode: 200,
            headers: {
                Expires: new Date(Date.now() + dayInMs).toUTCString()
            },
            body: JSON.stringify(players.filter((player: IPlayerTeam) => player.team.id === teamId))
        }))
}

module.exports.games = (event: IEventPayload, context, callback: ICallback): void => {
    // Convert to PST, place of last games of the day in North America
    var pstOffset: number = hourInMs * 8
    var date: Date = new Date(Date.now() - pstOffset)
    var today: string = dateFormat(date, "yyyy-mm-dd")

    s3
        .getObject({
            Bucket: "player-number",
            Key: "games.json",
            ResponseContentType :"application/json"
        })
        .promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
        .then((games: Array<IGame>) => callback(null, {
            statusCode: 200,
            headers: {
                Expires: new Date(new Date().setHours(23, 59, 59, 999) + pstOffset).toUTCString()
            },
            body: JSON.stringify(games.filter((game: IGame) => game.date === today))
        }))
}
