# espruino-alexa (WIP)

let Wifi = require('Wifi'),
    Alexa = require('alexa');


let alexa = new Alexa(Wifi, {
  wifi: {
    ssid: 'your-wifi-ssid',
    password: 'your-wifi-password'
  }
});
