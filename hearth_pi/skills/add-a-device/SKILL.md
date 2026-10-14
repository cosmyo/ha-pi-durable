---
name: add-a-device
description: Help the owner add a new device or integration to Home Assistant (a discovered device, a new hub, bulb, plug, sensor or service). Use when they ask to add, pair, connect or set up a device or integration.
---

# Add a device

Goal: the owner's new device or integration set up in Home Assistant, one
clear step at a time, with every secret entered by the owner in Home
Assistant's own UI and never in chat.

## Is Hearth allowed to help here?

- **Admin access mode** (`ha_integrations_read` and `ha_flow_propose` are
  available): follow the flow below.
- **Scoped mode** (those tools are missing): you cannot set anything up.
  Explain the steps in Home Assistant instead: Settings > Devices & services
  > Add integration, search for the brand, follow the dialog. Say that the
  > owner can enable Admin access mode in the App configuration if they want
  > Hearth to help with setup, and that it stays an approval-per-step flow.

## Never in chat

- Never ask for, accept, repeat or store passwords, API keys, tokens, PINs,
  pairing codes, setup codes, Matter/HomeKit QR codes, Zigbee/Z-Wave
  install codes or Wi-Fi passwords. If the owner types one anyway, do not
  repeat it and do not put it in a proposal; tell them to enter it in Home
  Assistant instead, and suggest changing it if it was a real secret.
- `ha_flow_propose` refuses fields whose names look secret. Do not try to
  rename or work around a field to get a value through.

## Flow

1. **Look first.** Call `ha_integrations_read` with `source: "discovered"`.
   Home Assistant often finds devices on the network by itself (a hub, a
   TV, a printer). Also check `source: "entries"` for the brand, so you do
   not add something that is already set up.
2. **Explain the device.** In 2–4 short lines: what it is, which
   integration fits (the handler, for example `example_hub`), what setup will
   ask for (an address, a button press on the device, a code), and whether
   it needs a cloud account. If you are not sure which integration fits,
   search `source: "handlers"` with a short query and ask the owner to
   confirm the brand or model. Do not guess between two integrations.
3. **Choose the path.**
   - Discovered flow: use its `flowId` and `handler`.
   - A listed flow whose `source` is `reauth`, `reconfigure`, `import` or
     `system` is not a new device: Hearth cannot step or cancel it; the
     owner continues it in Home Assistant (Settings > Devices & services).
   - Not discovered: start one with `op: "init"` and the handler.
   - Pairing-heavy devices (Matter, Thread, HomeKit devices, Zigbee or
     Z-Wave devices joining an existing network, anything with a QR code or
     a printed setup code): send the owner to Home Assistant's UI from the
     start (below). Pairing usually needs the phone app, a QR scan or a code.
4. **One step at a time.** Each `ha_flow_propose` call is one proposal the
   owner approves (setup steps are high risk; some integrations are
   critical and need a typed confirmation word). After each receipt, read
   `flowResult`:
   - `form`: say which fields come next. Fill only non-secret ones the
     owner told you or that are obvious (host, name, a choice from
     `options`), then propose `op: "step"` with exactly those values.
     If any field is marked `secret: true`, stop and hand over (below).
   - `menu`: ask the owner which option, then propose a step with
     `{"next_step_id": "<option>"}`.
   - `errors`: explain each code plainly (`cannot_connect`: Home Assistant
     could not reach the device; check power, network and address;
     `invalid_auth`: the credentials are wrong and must be entered in Home
     Assistant). Ask before proposing the step again with changed values.
   - `progress`: Home Assistant is waiting (for example for a button press
     on the device). Tell the owner what to do on the device, then propose
     a step with no values to continue.
   - `external`: sign-in happens in Home Assistant; hand over.
   - `create_entry`: say what was added (its title) and offer to name the
     new devices or put them in rooms (the owner can approve registry
     changes) or to open its page via `continueIn`.
   - `abort`: say why (`reason`, for example `already_configured`) and
     stop.
5. **Report honestly.** Pending means waiting for approval; never say a
   device was added before a receipt shows `create_entry`. A failed step
   did not run. An unknown outcome is never retried: say so, suggest the
   owner checks Settings > Devices & services, and leave reconciliation to
   them (`source: "discovered"` and `source: "entries"` help them see the
   current state).

## Handing over to Home Assistant

When a step needs a secret, a code, a QR scan or an external sign-in:

1. Tell the owner what Home Assistant will ask for and that they enter it
   there, not in chat.
2. Point them to `flowResult.continueIn` (the receipt card has an **Open in
   Home Assistant** link):
   - `/config/integrations/dashboard`: a discovered device; it waits under
     Discovered, where **Add** continues it.
   - `/config/integrations/dashboard/add?domain=<handler>`: Home
     Assistant's own setup dialog for that integration, started fresh.
3. If Hearth started the flow itself (not discovered), propose
   `op: "abort"` for it so it does not linger; the owner's dialog in Home
   Assistant replaces it. Never abort a discovered flow just to hand over.
4. Offer to continue afterwards: naming devices, rooms, a dashboard view.

## Examples (synthetic)

- "Add the new hub Home Assistant found": read discovered flows, see
  `example_hub` with `stepId: "confirm"`, explain, propose a step with no
  values, then report the `create_entry` title.
- "Set up my network printer at printer.example": propose `init` for its
  handler, then a step with `{"host": "printer.example"}` once the form asks
  for `host`.
- "Pair my new Matter plug": explain that pairing needs the plug's QR or
  setup code and the Home Assistant companion app on a phone (Settings >
  Devices & services > Add device), and do not start a flow in Hearth.
