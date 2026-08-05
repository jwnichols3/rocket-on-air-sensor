# rocket-on-air-sensor

Sense when a Zoom or Google Meet call is in progress on Rocket's Mac and signal another
machine to turn an on-air light on or off.

## Status

Greenfield. Architecture is open. See `CONTEXT.md` for the problem statement and the
open questions we need to resolve before building.

## The idea

```
[Mac in a call?] --sense--> [detector] --message--> [receiver device] --> [on-air light]
```

Three unknowns, all to be determined:

1. **Sensing** - how to reliably detect a Zoom/Meet call in progress (mic/camera in use,
   process detection, calendar, something else).
2. **Transport** - how the detector tells the receiver (MQTT, HTTP, Home Assistant,
   direct GPIO over network, etc.).
3. **Receiver + light hardware** - what device drives the light (Raspberry Pi, ESP32,
   smart plug, busylight-style USB device, etc.).
