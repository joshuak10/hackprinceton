# Café snapshot check: does a Jev café look like a real one for an hour?

> **Date:** Nov 14, 2026 · HackPrinceton Fall 2026
> **Status:** first write-up. Not yet reviewed by the team. An independent review of the method was still running when this was written; its corrections are not folded in.
> **Scope:** one real hour (13 stills) against 30 simulated hours. This is a check, not a calibration. It is a different test from the per-arrival tally in [TALLY_SHEET.md](TALLY_SHEET.md).

## 1. The answer

- **The simulated café is consistent with the log on every measure chosen in advance.** The real hour falls inside the range of the 30 simulated hours for the average, the spread, the lowest and the highest count, both for people seated and for people standing.
- **That is a weak pass.** The simulated hours differ a lot from each other, so most plausible cafés would fall inside.
- **The real standing crowd swings more than the simulated one.** The log goes from 1 person standing to 13 or 14 within the hour. Its spread is above 27 of the 30 runs.
- **The real seated count is steadier than the simulated one.** Its spread is below 24 of the 30 runs.
- **The averages are not a test.** Two unknowns were tuned to reach them (section 4).

## 2. The real data

`cafe_people_counts.pdf`, Batch 1: estimated counts of visible people in 13 screenshots of a café video, about five minutes apart, video time 1:00 to 2:00. Counts only: no names, faces or images.

| | Average | Spread (sd) | Lowest | Highest |
|---|---|---|---|---|
| Seated | 10.8 | 1.6 | 9 | 14 |
| Standing customers | 6.0 | 3.6 | 1 | 13.5 |

Figures use the midpoint of each counted range (for example "13-14" is 13.5).

What the log does not give: how many people arrived, how long an order takes, how long people sit, how many seats there are, how many staff were serving (staff were visible in only 3 of the 13 stills), or the time of day. Standing customers include people ordering, waiting for a drink and walking, which the stills cannot tell apart. Screenshots 7 and 11 have no timestamp.

## 3. The simulated café

One world, two places. Every number below is an assumption unless marked tuned.

| Setting | Value | Where it came from |
|---|---|---|
| Counter | 2 staff, 2.5 minutes an order | The repo's café world (`worlds/alder-pine-cafe.json`) |
| Seats | 18, each held for 0.6 to 1.4 times the seat time | Assumed. At most 15 were seen occupied. |
| Seat time | 23 minutes | **Tuned** |
| Arrivals | 106 over 155 minutes (about 41 an hour), at a constant random rate | **Tuned** |
| Customers | 4 groups, 12 fictional cast members: here to sit 35%, regulars 20%, on their way somewhere 30%, passers-by 15% | Assumed |
| Patience | 7, 10, 5 and 6 minutes | The four values in the repo's café world, assigned to these groups by hand |
| What a person is told about a line | The number of people in line and the staff serving (`waiting.lineShows: "people"`), no patience verdict, asked again every 5 minutes | docs/PROTOTYPE.md §16 and §16b |
| Time of day | Mid-morning | Assumed |

- Each person may visit up to two places. Jev decides where each person goes (the counter, the seats, or out), whether to join a line, and whether to keep waiting.
- The run is 155 simulated minutes. The first 90 are warm-up from an empty room, because the log starts an hour into the video with the café already full. The compared hour is minutes 90 to 150.6.
- Runs were recorded with the CLI: `node bin/swarm.js run <world> --provider jev --seed N --batch-window 0`. With `--batch-window 0` a person is not held standing while a batch of questions fills.

## 4. How the comparison was made

- **Counting.** From each run's `frames.json`, at the 13 snapshot moments: seated is everyone being served at the seats (state code 2, drawn within 2.2 map units of that place); standing is everyone else in the frame (walking in, in line, being served at the counter, deciding, walking out). Seats in use counted this way match the engine's own seat busy time to 0.00 in every run.
- **Distributions, not moments.** Simulated minute 20 has no reason to be the real minute 20. Each hour is reduced to its average, spread, lowest and highest count, and the real hour is placed among the simulated ones.
- **Two numbers were tuned, on separate seeds.** Arrivals and seat time were adjusted over two rounds of Jev runs on seeds 101 to 103 until the two averages were near the observed ones, then frozen. The test used fresh seeds 1 to 30.
- **Measures chosen before any Jev run:** average, spread (sd), lowest and highest.
- **Two measures added after the first ten test runs:** swing (spread divided by average) and range (highest minus lowest). The test runs' averages sat above the observed ones, and a spread in people is not comparable across different averages. Read these two as a follow-up, not as a planned test.

## 5. Results

30 Jev runs (`jev-1.14.0`), seeds 1 to 30.

| | Observed | Simulated: lowest – average – highest | Runs below / above observed |
|---|---|---|---|
| Seated, average | 10.8 | 7.9 – 11.7 – 16.5 | 12 / 18 |
| Seated, spread | 1.6 | 1.3 – 2.4 – 4.6 | 6 / 24 |
| Seated, lowest | 9 | 2 – 7.8 – 13 | 19 / 10 |
| Seated, highest | 14 | 11 – 15.5 – 18 | 8 / 20 |
| Standing, average | 6.0 | 4.2 – 7.1 – 11.2 | 10 / 20 |
| Standing, spread | 3.6 | 1.3 – 2.5 – 4.6 | 27 / 3 |
| Standing, lowest | 1 | 0 – 2.9 – 7 | 1 / 22 |
| Standing, highest | 13.5 | 8 – 11.4 – 16 | 25 / 5 |
| Standing, swing (added later) | 0.60 | 0.16 – 0.37 – 0.58 | 30 / 0 |
| Standing, range (added later) | 12.5 | 5 – 8.5 – 15 | 28 / 2 |

**The standing mismatch, checked three more ways.**
- Among the 12 runs whose standing average is within one person of the observed 6.0, one has a spread as large as the observed 3.6.
- The real hour has both a still with 1 person standing and a still with 13 or more. Two of the 30 runs do (seeds 8 and 13).
- With a different measure of burstiness, variance divided by average, the real hour scores 2.2 and the runs 0.2 to 2.7 (average 1.0). One run is above the real hour, so the real hour is not beyond every run on every measure.

**What the simulated people did.**

| | Average over 30 runs | Range |
|---|---|---|
| Reached the counter | 92% | 85 to 98% |
| Sat down | 69% | 58 to 81% |
| Sat before ordering | 9% | 4 to 18% |
| Sat and never ordered | 2% | 0 to 8% |
| Walked away from the counter line | 56 of 3,197 people | 0 to 5 a run |

- A simulated standing crowd of 7.1 is, on average, 2.3 people in line, 1.8 being served at the counter, and 3.0 walking, deciding or waiting for a seat.
- 8,208 decisions, 7,836 Jev requests, none answered by the rule model. About $0.30 for the test and $0.05 for tuning (TypeSafe's published price, unverified).

## 6. What it shows and what it does not

**Shows**
- A café built from plain assumptions, with Jev deciding where each person goes, produces seated and standing counts of the same size and rough spread as one real hour.
- Jev's choices in this world are sensible: almost everyone orders, about two in three sit, and under 1% leave without being served anywhere.
- The simulated standing crowd is too even.

**Does not show**
- That the simulated customers behave like real ones. The stills cannot say who arrived, who walked away, or how long anyone waited, and those are the decisions Jev makes.
- Anything about lines. Jev was asked whether to join a line in about 3% of decisions, because the engine asks only when the estimated wait is over 8 minutes.
- That the assumed numbers are right. Two staff, 2.5 minutes, 18 seats and the customer mix were not observed. Other values could match as well or better.
- A match on the averages. They were tuned.

## 7. Open questions

- `[open]` **Why the real standing crowd swings more.** A hypothesis, not a finding: simulated people arrive one at a time and decide alone (docs/PROTOTYPE.md §18, "Parties"), while real customers arrive in groups. Other candidates the stills cannot rule out: drinks made in batches, one slow order holding up the counter, part of the line out of the camera's view, or counting error on crowded frames.
- `[open]` **Why the real seated count is steadier.** Possibly longer and more varied stays than the uniform 14 to 32 minutes used here, or fewer seats than 18.
- `[open]` **People who sit and never order.** A person who walks away from the counter line can still choose the seats. It is 2% of people here and should be closed off in the world or the engine before this world is used for anything else.
- `[open]` **The test seeds ran above the observed averages** (11.7 seated and 7.1 standing against 10.8 and 6.0). Tuning on three seeds was too few to centre them.

## 8. What would make this a real test

- A per-arrival tally from the same video ([TALLY_SHEET.md](TALLY_SHEET.md)): how many were in line when each person arrived, and whether they joined. That tests a decision Jev makes. These 13 stills cannot stand in for it.
- The number of people who came through the door in the hour, which removes one of the two tuned numbers.
- Party sizes, and a count of seats in view.
- More than one hour.

## 9. Files and how to run it again

The world, the transcribed counts, the comparison script and the recorded runs are under `data/validation/livestream/cafe-hour/`, which is not in the repository (`data/` is git-ignored), so they exist only on the machine that ran this.

| File | What it is |
|---|---|
| `observed.json` | The 13 stills, transcribed from the PDF |
| `world.json` | The café world, with the frozen tuned values |
| `compare-snapshots.mjs` | Reads recorded runs and prints the tables in section 5 |
| `runs-tune1/`, `runs-tune2/` | The tuning runs (seeds 101 to 103) |
| `runs-test/` | The 30 test runs |
| `test-result.json` | The comparison as JSON, with each run's 13 counts |

```sh
node bin/swarm.js run data/validation/livestream/cafe-hour/world.json --provider jev --seed 1 --seeds 30 --batch-window 0 --out data/validation/livestream/cafe-hour/runs-test
node data/validation/livestream/cafe-hour/compare-snapshots.mjs data/validation/livestream/cafe-hour/observed.json data/validation/livestream/cafe-hour/runs-test
```

A live Jev rerun of the same seed does not repeat exactly, so a second set of 30 runs will give slightly different numbers.
