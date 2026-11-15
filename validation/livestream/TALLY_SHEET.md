# Livestream tally: do real customers join a line the way Jev's do?

One hour of a public café or counter livestream, counted by hand, compared with Jev's answers to the same question (`validation/jev-line-probe.js`, docs/PROTOTYPE.md §16b). It checks one thing: **how the chance of joining changes with the number of people already in line.**

## Before you start

- **Pick a stream that shows the door, the line and the counter in one view.** You must see each customer arrive and see the line they face. A stream that shows only the counter, or only the seating, cannot answer this.
- **Pick a busy hour.** Lunch or the morning rush. An hour with no line gives no information.
- **Count only. Record no names, faces, clothing descriptions, screenshots or video.** The CSV holds numbers and outcomes only. It goes in `data/validation/livestream/` (gitignored), not in the repo.
- Copy `tally-template.csv` to `data/validation/livestream/<place>-<date>.csv` and delete its four example rows.

## What to write for each arrival

One row each time a customer (or a group that orders together) comes through the door and could order.

| Column | What to write |
|---|---|
| `clock` | The time on the stream, `HH:MM`. |
| `in_line` | **People in line when they arrive**, not counting anyone being served at the counter. Count a group standing together as the number of people, as a customer would see it. |
| `staff` | Staff taking orders or serving at that moment. Leave out staff who are only cleaning or on the floor. |
| `outcome` | `joined`: joined the line. `walked_away`: looked and left without joining. `left_line`: joined, then left before ordering. `no_line`: ordered straight away (nobody in line). |
| `group` | People in the party (1 if alone). |
| `note` | Anything that makes the row doubtful: "came in for the restroom", "picked up a mobile order", "could not see the door". |

**Leave out** anyone who only picks up a mobile or delivery order, uses the restroom, or works there. A delivery driver is not a customer deciding on the line. If unsure, write the row and say so in `note`; the comparison script skips rows whose note starts with `skip`.

## Tips for counting

- Pause the stream when two people arrive at once.
- `walked_away` is the hardest to see: watch for someone who stops inside the door, looks at the line and leaves within about a minute. If they leave after more than a minute in the line, it is `left_line`.
- Count in_line at the moment they arrive, not when they decide.
- Aim for **at least 60 arrivals**, with some at 5 or more in line. With fewer than about 10 arrivals at a given line length, that row of the comparison is too small to read.

## Compare with Jev

```sh
node validation/livestream/compare.js data/validation/livestream/<place>-<date>.csv
```

It prints, for each line-length bucket (0, 1–2, 3–4, 5–6, 7–9, 10+), how many arrivals there were, the share that joined, and Jev's average chance of joining from the last probe run (`data/validation/jev-line-probe.json`, "people" version, at the observed staff count). It also prints the join rate at the same line length with different staff, where the counts allow it, which is the deli study's test.

## How to read it

- **Shape first, level second.** The deli study found the chance of buying flat for short lines and falling faster above about 7 people. If real customers' join rate falls with line length about as fast as Jev's does, the agents react to lines like people. If Jev falls much faster, the simulation overstates walk-aways, and the size of the gap is the correction to report.
- **Staff should barely matter at the same line length.** If the livestream shows people joining a 6-person line more often when 3 staff are serving than when 1 is, the deli finding does not hold at this café, and that is worth saying.
- **One café, one hour, is a check, not a calibration.** Report the numbers with their counts. The probe asked Jev about people who had already reached the counter, while the livestream also sees people who turn away at the door, so expect real join rates to be higher than Jev's at short lines.
