'use strict';

const
    DefaultOptions = {
        debug: true,
        wifi: {
            ssid: null,
            password: null
        },
        alexa: {
            port: 1900,
            httpPort: 80
        },
        led: {
            namePrefix: 'LIGHT',
            pwm: false,
            pin: 13,
            onValue: 1,
            offValue: 0,
            brightness: 170
        },
        device: {
            pin: 12,
            onValue: 1
        }
    },
    EmptyFn = () => {},
    GUID_PREFIX = '904bfa',
    Dgram = require('dgram'),
    Http = require('http');

let Alexa,
    debug = function() {
        console.log.apply(null, arguments);
    };

function OnOff(alexa, isOn)
{
    let opt = alexa.options.led;

    debug(`OnOff ${isOn}`);

    alexa.onState = isOn;
    digitalWrite(alexa.options.device.pin, isOn ? alexa.options.device.onValue : !alexa.options.device.onValue);
    [digitalWrite, analogWrite][~~opt.pwm](opt.pin, [opt.offValue, [opt.onValue, opt.brightness][~~opt.pwm]][~~isOn]);
}

function buildUDPSearchResponse(alexa, info)
{
    debug(['---', 'buildUDPSearchResponse START'].join('\n'));

    let msg = [
        'HTTP/1.1 200 OK',
        'CACHE-CONTROL: max-age=86400',
        `DATE: ${(new Date()).toUTCString()}`,
        'EXT:',
        `LOCATION: http://${alexa.ip}:${alexa.options.alexa.httpPort}/setup.xml`,
        'OPT: "http://schemas.upnp.org/upnp/1/0/"); ns=01',
        `01-NLS: ${alexa.uuid}`,
        'SERVER: Unspecified, UPnP/1.0, Unspecified',
        'X-User-Agent: redsonic',
        'ST: urn:Belkin:device:**',
        `USN: uuid:Socket-1_0-${alexa.serialNumber}::urn:Belkin:device:**`,
        ''
    ].join('\r\n');

    debug([
        `UDP message sent to address: ${info.address} port: ${info.port}`,
        'UDP message:', msg,
        'buildUDPSearchResponse END',
        '---'
    ].join('\n'));

    return msg;
}

function buildSetupXmlResponse(alexa)
{
    debug(['******************************************************', 'doSetupAnswerXML'].join('\n'));

    let res = [
            '<?xml version="1.0"?>',
            '<root>',
            '<device>',
            '<deviceType>urn:OriginallyUS:device:controllee:1</deviceType>',
            `<friendlyName>${alexa.friendlyName}</friendlyName>`,
            '<manufacturer>Belkin International Inc.</manufacturer>',
            '<modelName>Emulated Socket</modelName>',
            '<modelNumber>1.0001</modelNumber>',
            `<UDN>uuid:Socket-1_0-${alexa.serialNumber}</UDN>`,
            '</device>',
            '</root>'
        ].join('\r\n');

    debug('******************************************************');

    return res;
}

function handleSetupGet(alexa, res)
{
    let response = buildSetupXmlResponse(alexa);

    res.writeHead(200, {
        'Content-Type': 'text/xml',
        'Content-Length': response.length,
        'Date': (new Date()).toUTCString(),
        'X-User-Agent': 'redsonic',
        'SERVER': 'Unspecified, UPnP/1.0, Unspecified',
        'Connection': 'close',
        'LAST-MODIFIED': 'Sat, 01 Jan 2000 00:00:00 GMT'
    });
    res.end(response);
}

function handleUnknownGet(alexa, res)
{
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('Unknown GET command received');
}

function handleGet(alexa, req, res)
{
    debug('Get received');
    [handleUnknownGet, handleSetupGet][~~(req.url === '/setup.xml')](alexa, res);
}

function handleOtherUrlPost(alexa, req, res)
{
    debug([`Post OTHER URL ${req.url} received`, 'doPost STARTED'].join('\n'));

    let urlParts = url.parse(req.url, true),
        length = req.headers["Content-Length"];

    if (length < 1024) {
        req.on('data', d => {
            alexa.cache.content += d;

            if (alexa.cache.content.length === length) {
                debug([
                    `URL ${urlParts}`,`XXX ${urlParts.pathname}`, `Length ${length}`, `data= ${alexa.cache.content}`,
                    `data length= ${alexa.cache.content.length}`
                ].join('\n'));

                res.writeHead(200);
                res.end(alexa.cache.content);
                alexa.cache = Object.assign(alexa.cache, {content: ''});
            }
        });
    } else {
        res.writeHead(413);
        res.end();
    }
}

function handleControlPost(alexa, req, res)
{
    debug('Post (/upnp/control/basicevent1) received, start special handling doPost_handleUpnpControl');

    req.on('data', d => {
        alexa.cache.content += d;

        let databack, elapsed, currentTime,
            length = req.headers['Content-Length'];

        if (alexa.cache.content.length === length) {
            let isSet = alexa.cache.content.indexOf('<u:SetBinaryState xmlns:u') !== -1,
                isGet = alexa.cache.content.indexOf('<u:GetBinaryState xmlns:u') !== -1,
                isOn = alexa.cache.content.indexOf('<BinaryState>1</BinaryState>') !== -1,
                isOff = alexa.cache.content.indexOf('<BinaryState>0</BinaryState>') !== -1;

            debug(`*** STATUS RECEIVED: isSetStatus ${isSet}, isGetStatus ${isGet}, isOn ${isOn}, isOff ${isOff}`);

            databack = alexa.cache.content;
            alexa.cache.content = '';

            if(!isSet && !isGet && !isOn && !isOff) {
                debug(['Bad request from Amazon Echo', alexa.cache.content].join('\n'));

                res.writeHead(400, {'Content-Type': 'text/plain'});
                res.end('Bad request from Amazon Echo');
                return;
            }

            if(isSet) {
                currentTime = getTime();
                elapsed = currentTime - alexa.cache.lastTime;

                if(elapsed < 2.0) {
                    debug(`Command (SetBinaryState) ignored, last command received less than ${elapsed} seconds ago`);

                    res.writeHead(400, {'Content-Type': 'text/plain'});
                    res.end('Command (SetBinaryState) received too often - ignored');
                    return;
                }

                alexa.cache.lastTime = currentTime;

                debug(`Alexa is asking to turn ${isOn ? 'ON' : 'OFF'} a device`);

                OnOff(alexa, isOn);
            } else {
                debug('Sending answer to GetBinaryState request');

                databack = databack.replace('u:GetBinaryState', 'u:GetBinaryStateResponse')
                        .replace('<BinaryState>1</BinaryState>', `<BinaryState>${~~alexa.onState}</BinaryState>`)
                        .replace('<BinaryState>0</BinaryState>', `<BinaryState>${~~alexa.onState}</BinaryState>`);

                debug(`databack= ${databack}`);

                res.writeHead(200, {
                    'Content-Length': databack.length,
                    'Content-Type': 'text/xml',
                    SOAPACTION: 'urn:Belkin:service:basicevent:1#GetBinaryStateResponse',
                });
                res.end(databack);
            }
        }
    });
}

function handlePost(alexa, req, res)
{
    [handleOtherUrlPost, handleControlPost][~~(req.url === '/upnp/control/basicevent1')](alexa, req, res);
}

function onHttpRequest(req, res)
{
    debug([
        'onHttpRequest',
        '******************************************************',
        `Req header= ${JSON.stringify(req.headers, null, 4)}`,
        `Req method= ${req.method}`,
        `Req length= ${req.headers['Content-Length']}`,
        `Req url= ${req.url}`,
        '******************************************************'
    ].join('\n'));

    [handleGet, handlePost][~~(req.method === 'POST')](this, req, res);
}

Alexa = function (wifi, options)
{
    let apOpts, mac, socket, me = this;

    wifi.getIP((err, ip) => {
        if (err) {
            throw new Error('Cant determine mac address');
        }

        mac = ip.mac.split(':');
        options = Object.assign(DefaultOptions, options);
        debug = options.debug === true ? debug : EmptyFn;

        me.onState = 0;
        me.options = options;
        me.cache = {data: '', lastTime: 0};
        me.uuid = [GUID_PREFIX].concat(mac).join('-');
        me.serialNumber = parseInt(mac.join('').slice(-5), 16);
        me.friendlyName = me.options.led.namePrefix + '-' + me.serialNumber;
        me.httpServer = Http.createServer(onHttpRequest.bind(me)).listen(me.options.alexa.httpPort);

        debug(`NAME: ${me.friendlyName}`, `SERIAL: ${me.serialNumber}`, `UUID: ${me.uuid}`);
        debug('startVAXIOT started');
        debug(`Connect to WIFI (${me.options.wifi.ssid})`);

        wifi.connect(me.options.wifi.ssid, {password: me.options.wifi.password}, conErr => {
            wifi.getIP((ipErr, ip) => {
                if (ipErr) {
                    throw new Error('Cant determine ip address');
                }

                me.ip = ip.ip;

                debug(`connected? err=${conErr} info=${JSON.stringify(ip, null, 4)}`);

                socket = Dgram.createSocket({type: 'udp4', multicastGroup: '239.255.255.250'});

                socket.on('error', err => {
                    debug('server.on error', err);
                    socket.close();
                });

                socket.on('message', (msg, info) => {
                    debug('server.on UDP message received');
                    debug(['---', `<${JSON.stringify(msg)}`, `<${JSON.stringify(info)}`, '---'].join('\n'));

                    socket.send(buildUDPSearchResponse(me, info), info.port, info.address);

                    debug('server.on UDP response sent');
                });

                socket.bind(me.options.alexa.port);
            });
        });
    });
};

module.exports = Alexa;