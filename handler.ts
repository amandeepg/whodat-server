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

interface HeaderExpires {
    Expires: string;
}

interface ResponsePayload {
    statusCode: number
    headers: HeaderExpires
    body: string
}

interface QueryParameters {
    team: string
}

interface EventPayload {
    method: string
    queryStringParameters: QueryParameters
}

interface Callback {
    (error: any, result: ResponsePayload): void
}

interface Color {
    hex?: Array<string>
    rgb?: Array<string>
}

interface TeamColor {
    name: string
    league: string
    colors: Color
}

interface Team {
    abbreviation: string
    city: string
    colour: string
    id: string
    league: string
    name: string
}

interface Game {
    awayTeam: Team
    homeTeam: Team
    date: string
    league: string
    location: string
    time: string
}

interface PlayerTeam {
    player: Player
    team: Team
    stats?: any
}

interface Player {
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

function getTeamsPromise(league: string): Promise<Array<Team>> {
    return request
        .getAsync(getRequestOptions(league + process.env.TEAMS_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.overallteamstandings.teamstandingsentry)
        .then((teams: Array<PlayerTeam>) => teams.map((team: PlayerTeam) => team.team))
        .tap((teams: Array<Team>) => teams.forEach((team: Team) => team.league = league))
}

function getGamesPromise(league: string, teams: Array<Team>): Promise<Array<Game>> {
    return request
        .getAsync(getRequestOptions(league + process.env.GAMES_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.fullgameschedule.gameentry)
        .tap((games: Array<Game>) => games.forEach((game: Game) => game.league = league))
        .tap((games: Array<Game>) => games.forEach((game: Game) => {
            game.awayTeam = findTeam(teams, game.awayTeam)
            game.homeTeam = findTeam(teams, game.homeTeam)
        }))
}

function getPlayersPromise(league: string, teams: Array<Team>): Promise<Array<PlayerTeam>> {
    return request
        .getAsync(getRequestOptions(league + process.env.PLAYERS_URL))
        .then(r => r.body)
        .then(b => JSON.parse(b, normalizeKeys))
        .then(j => j.cumulativeplayerstats.playerstatsentry)
        .tap((players: Array<PlayerTeam>) => players.forEach((player: PlayerTeam) => player.player.league = league))
        .tap((players: Array<PlayerTeam>) => players.forEach((player: PlayerTeam) => {
            player.team = findTeam(teams, player.team)
            player.player.gamesPlayed = player.stats.gamesPlayed["#text"]
            delete player.stats
        }))
}

function extractHex(colourHash: Color): string {
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
    var teamsFromApiPromise: Promise.Thenable<Array<Team>> = Promise
        .all([
            getTeamsPromise("nhl"),
            getTeamsPromise("nba"),
            getTeamsPromise("nfl")
        ])
        .then(_.flatMap)

    var teamColoursPromise: Promise.Thenable<Array<TeamColor>> = s3
        .getObject({
            Bucket: "player-number",
            Key: "colors.json",
            ResponseContentType: "application/json"
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
        .tap((teams: Array<Team>) => s3.putObject({
            Bucket: "player-number",
            Key: "teams.json",
            ContentType: "application/json",
            Body: JSON.stringify(teams)
        }).promise())
        .then((teams: Array<Team>) => {
            var gamesPromise = Promise
                .all([
                    getGamesPromise("nhl", teams),
                    getGamesPromise("nba", teams),
                    getGamesPromise("nfl", teams)
                ])
                .then(_.flatMap)
                .tap((games: Array<Game>) => s3.putObject({
                    Bucket: "player-number",
                    Key: "games.json",
                    ContentType: "application/json",
                    Body: JSON.stringify(games)
                }).promise())
            var playersPromise = Promise
                .all([
                    getPlayersPromise("nhl", teams),
                    getPlayersPromise("nba", teams),
                    getPlayersPromise("nfl", teams)
                ])
                .then(_.flatMap)
                .tap((players: Array<PlayerTeam>) => s3.putObject({
                    Bucket: "player-number",
                    Key: "players.json",
                    ContentType: "application/json",
                    Body: JSON.stringify(players)
                }).promise())
            return Promise.all([gamesPromise, playersPromise]).then(() => teams)
        })
}

function addColoursToTeams(teams: Array<Team>, teamColours): Array<Team> {
    return teams.map(team => addColoursToTeam(team, teamColours))
}

function addColoursToTeam(team: Team, teamColours): Team {
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

function findTeam(teams: Array<Team>, teamToFind: Team): Team {
    return teams.find(team => team.id === teamToFind.id)
}

module.exports.initData = readAllDataFromApi

module.exports.teams = (event: EventPayload, context, callback: Callback): void => {
    s3
        .getObject({
            Bucket: "player-number",
            Key: "teams.json",
            ResponseContentType: "application/json"
        }).promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
        .then((teams: Array<Team>) => callback(null, {
            statusCode: 200,
            headers: {
                Expires: new Date(Date.now() + weekInMs).toUTCString()
            },
            body: JSON.stringify(teams)
        }))
}

module.exports.players = (event: EventPayload, context, callback: Callback): void => {
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
            ResponseContentType: "application/json"
        }).promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
        .then((players: Array<PlayerTeam>) => callback(null, {
            statusCode: 200,
            headers: {
                Expires: new Date(Date.now() + dayInMs).toUTCString()
            },
            body: JSON.stringify(players.filter((player: PlayerTeam) => player.team.id === teamId))
        }))
}

module.exports.games = (event: EventPayload, context, callback: Callback): void => {
    // Convert to PST, place of last games of the day in North America
    var pstOffset: number = hourInMs * 8
    var date: Date = new Date(Date.now() - pstOffset)
    var today: string = dateFormat(date, "yyyy-mm-dd")

    s3
        .getObject({
            Bucket: "player-number",
            Key: "games.json",
            ResponseContentType: "application/json"
        })
        .promise()
        .then(data => data.Body.toString())
        .then(JSON.parse)
        .then((games: Array<Game>) => callback(null, {
            statusCode: 200,
            headers: {
                Expires: new Date(new Date().setHours(23, 59, 59, 999) + pstOffset).toUTCString()
            },
            body: JSON.stringify(games.filter((game: Game) => game.date === today))
        }))
}
