# Testing the Bluetooth mesh on real phones

The mesh is simulated and unit-tested (including flaky links) but has never run on real radios. This is a 30-minute test that tells you whether it works. You need 4 Android phones with PrivCord installed (Android 8+), Bluetooth on, and Location and "Nearby devices" permission granted.

## Setup
1. On every phone: Settings > Connection > turn on **Bluetooth mesh**. Turn on airplane mode, then turn Bluetooth back on, so you know nothing travels over the internet.
2. On every phone: Channels > join `#fieldtest`.
3. Look at the line under the mesh toggle on each phone: "Linked phones now: N. Heard X new messages, passed on Y copies."

## Tests
| # | What to do | Pass if |
|---|---|---|
| 1 | Put all 4 phones within 2 m. Wait 60 s. | Each phone shows at least 1 linked phone (up to 5). |
| 2 | Phone A posts "one" in `#fieldtest`. | B, C and D show it within 15 s. |
| 3 | Line them up so A only reaches B, B reaches C, C reaches D (about 10 m apart, with a wall or two between A and D). A posts "two". | D shows it. Phones B and C show "passed on" going up. This is the multi-hop test. |
| 4 | Phone C walks away until it loses B and D. A posts "three". Wait 2 minutes. C walks back. | C shows "three" after it returns (store, carry, forward). |
| 5 | Switch off Bluetooth on B for 30 s, then on again. A posts "four". | B reconnects without you touching anything, and shows "four". |
| 6 | Leave all 4 phones with the screen off for 20 minutes, then post from A. | Messages arrive, or you note on which phone model they did not (battery limits). |
| 7 | Check battery use after 1 hour in Android Settings > Battery. | Write the percentage down. |

## What to send back
For each test: pass or fail, the phone models and Android versions, and for any failure the "Linked phones / Heard / passed on" line from each phone. If a test fails at step 1 (no links), say which phones are involved: that points at the Bluetooth connection code and not at the relaying.

## What the simulation already proves
Relaying across several phones, the hop limit, no echo and no endless loops, carrying a message for a phone that shows up later, per-sender flood limits, and (since the flaky-link tests) that a packet lost because a link dropped mid-send is sent again when the link returns. It does not prove anything about real Bluetooth: connection setup, range, and phone makers' background limits are only learned from this test.
