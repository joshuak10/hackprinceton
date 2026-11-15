# Swarmscope: new and returning customers over days (draft spec)

> **Version:** v0.3 draft · Nov 14, 2026 · HackPrinceton Fall 2026
> **Scope:** item 1 of [INDEPENDENT_BUSINESS_SPEC.md](INDEPENDENT_BUSINESS_SPEC.md) §9, "Repeat visits with memory", worked out in detail. Nothing here is built. The engine contract, [docs/PROTOTYPE.md](docs/PROTOTYPE.md), still governs the code; when this is approved, its engine parts go there as a new section before any code.
> **Before Sunday's submission:** only the return probe and the "next morning" mode in Ask the room (section 8, steps 1 and 2). The multi-day loop comes after the hackathon.
> **Source:** two research passes on Nov 14. The first (one research agent) gathered the published effects in section 4. The second (three read-only agents: one read the engine code, one traced vendor benchmarks to their origin, one worked out capacity and margin, removed in v0.3) added sections 2b, 4b, 5b and 9b. Web sources are listed in section 11. The published figures were gathered from papers, abstracts and summaries and have not all been checked against the full papers. Treat each as "to confirm" until someone reads the source.

## 1. The question

An independent owner's real fear is not one bad lunch. It is losing customers who would have come back, and failing to win new ones. A single simulated day cannot show either. This spec simulates the same people over one to two weeks, so a change can be judged by who comes back and who comes for the first time.

Two owner questions:
- **Attracting new customers:** does this change bring people who have never been here?
- **Loyalty:** does this change make people come back, or drive regulars away?

## 2. What we measure

**New customers**
- First-time visitors per week.
- Reach: the share of people who have heard of the shop, and how (a friend, a review, a promotion, walking past).
- Trial: the share of people who know of the shop and come at least once.
- First-to-second visit: the share of first-timers who come back. Vendor figures put this at roughly 7 to 23% for restaurants without marketing (weak source; direction only). The second pass found 18.84% for one cohort, and 12 to 25% across the same vendor's own studies (section 2b).

**Loyalty**
- Return within 7 and within 30 days.
- Visits per customer per week, and the gap between visits.
- Regulars: people with 3 or more visits in 2 weeks (threshold `[open]`).
- Dropout: people not seen for N days.
- Word of mouth: good remarks minus bad ones, counted from what simulated people say, not a survey score.

These match the standard repeat-visit model, BG/NBD (Fader, Hardie & Lee 2005): each person has a visit rate and a chance of dropping out after each visit. An owner's point-of-sale export can be fitted to that model, which gives a real baseline to check the simulation against (section 9, level 3).

## 2b. The shape of coming back (vendor data)

One vendor, Bloom Intelligence, publishes the steps with their denominators. It is platform data from many restaurants, not an independent study. Guests are recognized by WiFi, online orders, reservations or the till, so a walk-in counter would miss many.

| After visit number | Share who make the next visit |
|---|---|
| 1 | 18.84% (12 to 25% across the vendor's own studies) |
| 2 | 47.23% |
| 3 | 63.05% |
| 4 | 70.61% |
| 5 | 75.85% |

New guests of Q4 2025, visits counted to Oct 8, 2026. The sample size is not stated.

- **Nearly all the loss is between the first and second visit.** Once a second visit happens, the chance of a third is 2.5 times higher.
- **No step passes 80%.** A circulating claim of "over 80% retention at visit 3" is contradicted: the measured step is 63%.
- **When returners come back.** Among guests who returned at all, about 15% had done so by day 7, 25% by day 14, 36% by day 30, 50% by day 60 and 59% by day 90. These are shares of returners, not of all first-timers. Multiplied through, about 7% of all first-timers are back within 30 days and about 11% within 90 (derived: 0.1884 × 0.36 and × 0.59; 4 to 9% and 7 to 15% across the 12 to 25% range). The vendor's 2025 report says 25% return within 90 days, so its own figures do not agree with each other.
- **By how the guest was first seen.** 12.7% of guests first seen on walk-in WiFi returned, against 22.4% of those who first ordered in store. Use it as an ordering, not as an effect.
- **Use.** The shape for the level 2 realism checks (section 9), and a starting point where the owner has no data. It describes people who chose to return, so it is not the effect of getting someone to visit N.

## 3. Method: check each signal before using it

The same method as the line check ([docs/PROTOTYPE.md](docs/PROTOTYPE.md) §16b):
1. Find a published field effect of one fact on customers.
2. Ask Jev the decision with only that fact changed, against a neutral control.
3. Check that Jev moves the right way, by roughly the right amount.
4. Only then let that fact into the multi-day simulation. Where Jev ignores a signal or overreacts to it (as it overreacts to long lines, §16b), use the measured effect as a rule for that signal instead.

**Always a neutral control.** Any added sentence moves Jev's answers by about 5 points ([docs/PROTOTYPE.md](docs/PROTOTYPE.md) §17), so each signal is compared with a sentence of the same length that says nothing about the shop.

## 4. Signals with published effects

| Signal a person is told | Published effect | Strength |
|---|---|---|
| Their last wait, and whether they gave up | de Vries, Roy & de Koster 2018, *Journal of Operations Management*: 94,404 customers of one restaurant over 12 months. Longer waits mean more walk-aways, a longer time until they come back, and shorter visits. Removing waiting would add about 15% revenue. | Strong. The per-minute figures need the full paper. |
| How the visit felt | Peak-end rule (Kahneman et al. 1993; Redelmeier & Kahneman 1996): people remember the worst moment and the last moment, not the average. | Strong. Decides how a visit is written into memory (section 5). |
| A price change against the remembered price | Hardie, Johnson & Fader 1993, *Marketing Science*: a rise above the remembered price hurts more than an equal cut helps (loss aversion). | Direction clear; the size is debated. |
| Star rating or reviews (new customers) | Luca 2016: one more Yelp star, 5 to 9% more revenue, for independent restaurants only. Anderson & Magruder 2012: half a star more, selling out 19 percentage points (49%) more often. | Strong, but measured as revenue and sell-outs, not one person's choice. |
| A friend's remark (new customers) | Trusov, Bucklin & Pauwels 2009: word-of-mouth referrals have a long-run elasticity of 0.53 on new sign-ups and last longer than marketing. | Medium. A website, not a shop. |
| A promotion or discount | Dholakia 2011 (324 businesses): about 80% of deal buyers were new, and about 20% (19.9%) came back at full price. 26.6% of the businesses lost money on the deal. (A second source gives the sample as about 500 businesses; to confirm.) An earlier survey (2010, 150 businesses) found the deal unprofitable for 32%, with restaurants faring worst. | Medium. A survey of businesses. Relevant to the sushi promotion. The 19.9% is about the same as any first-timer's return rate (section 2b), so a deal buys a first visit, not extra loyalty. |
| Stamp-card progress | Kivetz, Urminsky & Zheng 2006: the gap between purchases shrinks about 20% (0.7 days) as a café customer nears a free drink. A 12-stamp card with 2 bonus stamps was finished in a median 10 days, against 15 for a plain 10-stamp card. Nunes & Drèze 2006: a card given with 2 free stamps was completed 34% of the time, against 19%. | Strong field experiments. The second pass did not find the 20% figure in the sources it read; to confirm in the paper. |
| Long waits (vendor data) | uKnomi 2024 (drive-through): more than 1 in 3 repeat customers did not return within 90 days when service took over 10 minutes. | Weak; the vendor sells this analysis. Direction only. |
| Reviews that mention a deal (new customers) | Byers, Mitzenmacher & Zervas 2012: ratings from reviewers who mention a daily deal are 10% lower on average. | Medium. Daily-deal sites, not a shop's own promotion. |
| Repeated promotions | Mela, Gupta & Lehmann 1997 (8¼ years of panel data): customers become more sensitive to price and to promotions over time as promotions increase. | Direction only. Packaged goods. |
| A sign at the door (new customers) | FedEx Office 2012 (survey of 1,000 US adults): 76% say they have entered a store they had never visited because of its sign. Roggeveen, Nordfält & Grewal 2016 (field experiments in Swedish grocery): digital displays raised sales in the largest stores and lowered them in small ones, and only price messages worked. | Weak. A self-reported survey by a company that sells signs, and a grocery study. |

## 4b. Figures that did not hold up

These circulate in vendor material and in prompts. The second pass traced each to its origin. Do not use them as inputs or as pass rules.

| Claim | What was found |
|---|---|
| "70% of first-time guests never return" | No primary dataset. The vendor figures in section 2b put it at 75 to 88%. |
| "39.5% return within 30 days and 54% within 90" | Not found. The nearest real figures (36% and 59%) are shares of guests who returned at all. |
| "Over 80% retention once a guest reaches visit 3" | Contradicted: 63% (section 2b). A 2017 Paytronix figure of 90% after a fourth visit does not say who was counted or what "regularly" means. |
| Wallet pass: 65 to 75% adoption, 90% open rate | Vendor product pages, with no source and no denominator. |
| Loyalty app: 10 to 20% adoption, 83% uninstalled within 30 days | Unsourced. The one sourced 83% found means the opposite: 83% of surveyed fast-food customers have at least one such app (SMG 2022). |
| "Point expiration causes 35% of churn, app glitches 27%" | The numbers are real, but they are frustrations named in a survey, not churn (Alchemer 2026, 800 US fast-food loyalty members). Use them only to rank sources of friction. |
| "Contact a guest 7 days before their next visit: 61% more orders" | Misdescribed. A coupon went to app users a model already expected to order within 7 days. No control group (Tillster, vendor). |
| "Streaks give 2.3 times the order frequency, and 75% order above their average order value" | Misread. People who completed a challenge were 2.3 times more likely to increase their frequency than non-participants. They chose to take part, and there was no holdout. The 75% is not about order value (Tillster, vendor). |
| "One-to-one marketing gives 2.7 times the retention" | Not checked against its source, a vendor report. It compares guests who could be marketed to with guests who could not. |
| "Loyalty members visit 22% more" (Circana); "one-step sign-up reaches 42%" (Thanx); "35% return if contacted at 45 to 75 days, 12% after 90" (SevenRooms) | None traced to an original. Members choose to join, so a gap between members and non-members overstates any effect. |
| A win-back recovery rate | Vendor guides give 8 to 28% and contradict each other. No independent restaurant figure was found. |
| "28% of diners are dissatisfied with loyalty spam" | Reworded. The origin says dissatisfaction with fast-food loyalty programmes rose to 28% from 15% (Tillster, vendor). It is about programmes, not messages. |

## 5. How a multi-day run works

**A pool of people who persist.** The world's cast plus generated people. Each person keeps:
- whether they know the shop, and how they heard of it;
- a short visit history: day, the worst wait, how it ended (served or walked away), the price paid;
- stamp-card progress, if the shop has a card;
- remarks they heard from people they listen to;
- their usual days and times.

**Each morning, one Jev question per person:** "Do you go to <shop> today, go somewhere else, or skip?" What they are told includes their memory, written by code as facts in words, never as verdicts (Jev reads literally, §16). For example:
- "Last visit 3 days ago: waited about 20 min, 9 people ahead, left without ordering."
- "The latte went up 50 cents since last week."
- "A friend said the line was long on Tuesday."
- "8 of 10 stamps."
- "4.5 stars on reviews."

**The day runs on the existing engine.** The people who said yes become the day's arrivals, with their times; lines, waits, walk-aways and in-store decisions work as now.

**Each evening, memory is updated.** Each visit is stored in peak-end form: the worst moment and how it ended. Remarks carry into later days for the people who listen to the speaker. People who do not know the shop can learn of it by word of mouth, the rating, a promotion, or walking past (a base rate per day).

**Where the loop lives.** The engine's day is 30 to 1,440 minutes. The loop over days sits in the runner, outside the engine, so the engine itself needs little change: arrivals from a list, and memory text in the observation.

## 5b. What the engine has today (read from the code, Nov 14)

- **No state between runs.** Nothing is carried from one run to the next. A person's id is their position in the arrival schedule, so the same id is a different person under another arrival count. The pool of people who persist must live in the runner, with its own ids.
- **Who arrives is drawn at random.** The schedule comes from `arrivals.total` and `arrivals.shape`, and each arrival draws its cast member from its own random stream. "Arrivals from a list" therefore has to say who arrives as well as when.
- **Unknown fields are dropped.** A world with a new block such as `"loyalty": {...}` or `"memory": {...}` still validates, with the warning "unknown field; ignored", and the block is removed before the run. `worlds/schema.json` also refuses extra fields, so a compiled world would not carry it. New fields need `engine/spec.js` first.
- **What a run already records for each person** (`agents.json`), which the evening update can read: `waitTotal`, `served`, `abandons`, `spent`, `visits`, and `frustration` (0 to 4; Jev runs only, empty under the rule model).
- **Frustration lasts one run.** It lowers the same person's patience for the rest of that run (`patienceMult`, down to 0.6) and is then gone.
- **A message can already reach a person.** An offer (docs/PROTOTYPE.md §15) carries up to 160 characters to a group or a cast member, with or without a discount, and up to three are shown. So "8 of 10 stamps" can be told today as words. The rule model does not read the words.
- **Short waits are never asked about.** Jev is asked whether a person joins only when the estimated wait is over 8 minutes and over half their tolerance. A full sushi counter with nobody waiting is 7.5 minutes, so nobody is asked.
- **No metric for returning.** The closest are `shareNeverServed`, `walkAwaysPerPerson`, `avgSpent` and `avgFrustration`, by group and by cast member.

## 6. Changes to test, and the report

Changes: staff, price, a promotion, a stamp card, seats. Each is an existing lever or offer. Each runs over 1 to 2 simulated weeks on several seeds, against the same weeks without the change.

The owner reads, as ranges: "+N new customers a week, M more regulars", split by kind of customer (for example lunch-break workers, students, regulars).

**Three loyalty mechanisms to try first (second pass).** Each is told to a person as plain words. One evening will not show anyone returning, so these are for the return probe (section 8) and the loop.

| Mechanism | What a person is told | Runs today | What it must show |
|---|---|---|---|
| Stamp card with a head start | "Stamp card: 2 of 10 stamps are already filled. Tonight's meal adds one. The tenth meal is free." | As an offer with no discount, with Jev only | The card is finished more often with the head start, and visits come sooner near the reward (Nunes & Drèze 2006; Kivetz et al. 2006). |
| A message before the second visit, within 30 days | Needs the morning question | No | More first-timers come back than without the message. No measured lift exists to compare with (section 4b). |
| A third-visit treat | "Come three times in six weeks and the chef adds a piece on the house. Tonight counts as one." | As an offer with no discount, with Jev only | The only evidence for streaks is one vendor case study of people who chose to take part. Visits speed up near a reward and slow after it (Kivetz et al. 2006). |

The stamp-card message as a patch. `applyPatch` accepts it on the sushi world as "a message · to everyone":

```json
[
  { "kind": "offer", "offer": { "id": "stamp_card", "text": "Stamp card: 2 of 10 stamps are already filled. Tonight's meal adds one. The tenth meal is free." } }
]
```

## 7. Cost

- One Jev question per person per day for the morning decision, plus the in-store decisions of the people who come.
- The business spec estimates two weeks on five seeds at about $4 and 16 minutes for the large building. A café pool of about 150 people costs much less.

## 8. First steps

1. **Return probe** (a few hours, a few cents). `validation/jev-return-probe.js`, built like `validation/jev-line-probe.js`. It asks the morning question of about 8 cast members, changing one fact at a time against the neutral control:
   - last wait 0, 5, 10, 20 or 30 minutes;
   - served or walked away;
   - the same wait with a fast or a slow ending (peak-end);
   - the price up or down $0.50;
   - a friend's good or bad remark;
   - a 3.5, 4.0 or 4.5 rating;
   - a 20%-off promotion, for people who do not know the shop yet and for regulars;
   - stamps at 2 of 10 and at 8 of 10.

   About 1,000 to 2,000 requests. Each response curve is checked against the direction and rough size in section 4.
2. **Demo shortcut.** A "next morning" mode in Ask the room ([docs/PROTOTYPE.md](docs/PROTOTYPE.md) §17), with controls for the last visit, a friend's remark and the rating. It shows memory working live before the multi-day loop exists.
3. **The multi-day loop** (section 5), for signals that passed step 1.

**Before Sunday's submission, steps 1 and 2 only.** The loop needs people who persist, arrivals from a list and new engine fields (section 5b), and its results could not pass section 9b's bars in the time left.

## 9. Benchmark: how we test loyalty

No ready-made benchmark exists for simulated customers' loyalty. We test in three levels. The first two are gates; the third is the real test.

**Level 1: signal tests** (the return probe, section 8). Each has a pass rule from a published study (section 4):

| Test | Pass if the simulation shows |
|---|---|
| Last wait → coming back (de Vries et al. 2018) | The chance of returning falls as the last wait gets longer, and people who walked away return less than people who were served. |
| Price change (Hardie et al. 1993) | A 50-cent rise lowers returns more than a 50-cent cut raises them. |
| Stamp card, near the reward (Kivetz et al. 2006) | Visits come about 10–30% closer together at 8 of 10 stamps than at 2 of 10 (study: about 20%). |
| Stamp card, head start (Nunes & Drèze 2006) | A card that starts with 2 free stamps is finished clearly more often (study: 34% against 19%). |
| Promotion (Dholakia 2011) | The newcomers a 20%-off deal brings come back at full price no more often than newcomers who came without it. The study's 19.9% is about the same as any first-timer's return rate (section 2b), so a deal buys a first visit, not extra loyalty. |
| Star rating (Luca 2016) | A higher rating brings more first-time visitors, around the 5–9% revenue gain per star. |

Two notes:
- **The promotion test compares newcomers with newcomers.** An earlier rule ("about 20% come back at full price") would have passed even if the promotion changed nothing, because ordinary first-timers return at about 19% (section 2b). Adopted in v0.3.
- **The stamp-card test near the reward.** The 20% figure is still to confirm (section 4).

**Level 2: realism checks on the simulated sales log.** Two simulated weeks should look like a real customer base:
- Visit counts are lopsided: many people come once, and a few regulars make a large share of visits.
- The share of first-timers who return falls over time, then levels off.
- BG/NBD fits the log well. Real customer bases fit it; a poor fit means the behavior is off.
- Across competing counters, "double jeopardy" appears: smaller counters have fewer customers, and those customers are slightly less loyal (Ehrenberg's repeat-buying regularities, reported for choice between stores as well as brands).

**Level 3: a backtest on real sales data (the real benchmark).**
- Data: an owner's sales or loyalty-card export with customer IDs, covering a known change (a price rise, a new hire, a promotion).
- Test: calibrate on data from before the change only. Predict how many people returned after the change, and how often, and compare with what happened.
- Baseline to beat: BG/NBD fitted to the "before" data, which assumes nothing changed. If the simulation cannot beat "nothing changes", it adds nothing.
- This is the result that would convince a skeptic: it predicts a real change it never saw.
- Until owner data exists: public check-in data (for example the Foursquare check-ins from New York and Tokyo, with venue types such as coffee shops) can test levels 1 and 2 against real repeat visits, but has no known changes, so it cannot run the backtest. CDNOW is the classic BG/NBD benchmark, but it is online CD buying. Availability of both not yet checked.
- A livestream cannot measure loyalty: telling who is returning would mean recognizing faces, which we do not do.
- Owner data never goes in this public repo ([INDEPENDENT_BUSINESS_SPEC.md](INDEPENDENT_BUSINESS_SPEC.md) §10).

## 9b. When a result may be reported

- **Above rerun noise.** Two Jev runs of the sushi restaurant on the same seed with no change gave 18 and 14 walk-aways, 22 and 24 finished meals, and waits of 9.6 and 9.2 minutes. From that one pair, a change on one seed smaller than about 8 walk-aways, 4 meals or 0.8 minutes cannot be told from noise. Divide by the square root of the number of seeds: about 4.6, 2.3 and 0.5 at three seeds. These bars rest on one pair of reruns and should be measured again.
- **Same direction on every seed,** on at least three seeds (`holdsAcrossSeeds` in `run/effects.js`).
- **Walk-aways are events, not people.** One person can walk away from both places: 18 walk-aways were about 12 people.
- **Small groups.** A group in the sushi world is 6 to 11 people. Do not report a difference of fewer than 2 people.
- **No claim about new customers while arrivals are an input.** Until the morning question decides who comes, adding arrivals is an assumption, not a result.
- **One evening says nothing about 30 or 90 days.** It gives seats, waits, frustration and walk-aways by group.

## 10. Caveats and open questions

- **Most published effects are not one person's probabilities.** They are totals (revenue, sell-outs, time until the next visit). We can match direction and rough size, not exact values.
- **Errors compound across days.** Jev already walks away from lines more readily than real customers ([docs/PROTOTYPE.md](docs/PROTOTYPE.md) §16b: its chance of joining falls by about half from 1 to 15 people ahead, where the deli study saw purchases fall by about a tenth). In a multi-day loop each extra walk-away becomes a bad memory and a lower chance of coming back, so loyalty would come out understated, more so the more days run. Check the line behavior against real customers (the livestream tally, `validation/livestream/`) before trusting multi-day results, and report how much of a loss comes from walk-aways.
- **Noise adds up over days.** Two Jev runs of the same world and seed already differ by a few people, so multi-day results need several seeds and are reported as ranges.
- **The baseline needs the owner's data:** the share of repeat customers and visits per regular, from point-of-sale or stamp-card records. Without it, loyalty numbers are directional only. Owner data never goes in this public repo ([INDEPENDENT_BUSINESS_SPEC.md](INDEPENDENT_BUSINESS_SPEC.md) §10).
- **The vendor ladder is not an effect.** Section 2b describes people who chose to return. Getting someone to a second visit does not make them behave like those people.
- `[open]` The size of the pool, the regulars threshold, the walking-past base rate, and how fast a memory fades.
- `[open]` Whether the morning question is asked of everyone in the pool every day, or only of people whose usual days include today (cheaper).

## 11. Sources

- de Vries, Roy & de Koster 2018, "Worth the wait? How restaurant waiting time influences customer behavior and revenue", *JOM*: [Erasmus repository](https://repub.eur.nl/pub/106497), [VU listing](https://research.vu.nl/en/publications/worth-the-wait-how-restaurant-waiting-time-influences-customer-be/)
- Law, Hui & Zhao 2004, repurchase frequency in fast food: [Emerald](https://www.emerald.com/ijqrm/article/21/5/545/144101/Modeling-repurchase-frequency-and-customer)
- Luca, Yelp and revenue: [Harvard Magazine summary](https://www.harvardmagazine.com/2011/10/hbs-study-finds-positive-yelp-reviews-lead-to-increased-business)
- Anderson & Magruder 2012: [paper](https://are.berkeley.edu/~mlanderson/pdf/Anderson%20and%20Magruder.pdf)
- Trusov, Bucklin & Pauwels 2009: [RePEc](https://ideas.repec.org/a/vrs/gfkmir/v2y2010i1p26-33n4.html), [UMD summary](https://rhsmith.umd.edu/news/wom-vs-traditional-marketing)
- Dholakia 2011, daily deals: [Fortune](https://fortune.com/2011/06/16/study-offers-grim-news-on-deal-sites-like-groupon/)
- Kivetz, Urminsky & Zheng 2006, goal gradient: [Columbia PDF](https://business.columbia.edu/sites/default/files-efs/pubfiles/1200/goalgradient.pdf)
- Nunes & Drèze 2006, endowed progress: [Wharton summary](https://knowledge.wharton.upenn.edu/?p=5630)
- Hardie, Johnson & Fader 1993: [abstract](https://brucehardie.com/abstracts/abstract-hjf93.html)
- Fader, Hardie & Lee 2005, BG/NBD: [paper](https://www.brucehardie.com/papers/bgnbd_2004-04-20.pdf)
- uKnomi 2024 (vendor): [report](https://uknomi.com/wp-content/uploads/2024/12/The-Hidden-Impact-Final.pdf)
- Bloom Intelligence and Toast (vendors), first-visit return rates: [Bloom](https://bloomintelligence.com/blog/first-time-restaurant-guests-return-rate/), [Toast](https://pos.toasttab.com/blog/data/restaurant-loyalty-program-return-rate)
- Peak-end rule: Kahneman et al. 1993; Redelmeier & Kahneman 1996 (standard literature; not re-checked).

Added by the second pass:
- Bloom Intelligence (vendor), the visit ladder and return timing: [recovering lost guests](https://bloomintelligence.com/blog/recovering-lost-restaurant-guests/), [benchmarks](https://bloomintelligence.com/blog/restaurant-benchmarks/), [2025 retention report](https://bloomintelligence.com/blog/state-of-restaurant-guest-retention-2025/)
- Dholakia 2010 and 2011, daily deals: [2010 release](https://www.eurekalert.org/news-releases/805401), [ClickZ on the 2011 study](https://clickz.com/?p=51006)
- Byers, Mitzenmacher & Zervas 2012, daily deals and ratings: [arXiv](https://arxiv.org/abs/1109.1530)
- Mela, Gupta & Lehmann 1997, long-term effect of promotions: [Duke listing](https://scholars.duke.edu/display/pub1485948)
- FedEx Office 2012, sign survey: [release](https://newsroom.fedex.com/newsroom/fedex-office-survey-standout-signs-contribute-to-sales/)
- Roggeveen, Nordfält & Grewal 2016, digital displays: [Journal of Retailing](https://doi.org/10.1016/j.jretai.2015.08.001)
- Alchemer 2026 (survey vendor), fast-food loyalty frustrations: [summary](https://alchemer.com/resources/blog/new-research-what-diners-expect-from-qsr-loyalty-programs/)
- Tillster (vendor), challenges and predicted-order coupons: [case study](https://tillster.com/case-studies/increasing-order-frequency), [blog](https://tillster.com/blog/restaurant-customer-retention)
- Paytronix 2017, the "fourth visit" figure: [FSR Magazine](https://fsrmagazine.com/content/research-loyalty-established-fourth-visit)
- SMG 2022, fast-food app ownership: [blog](https://smg.com/blog/from-touchpoint-to-focal-point-championing-mobile-app-adoption-for-qsr)

## 12. Change log

- **v0.3 draft · Nov 14, 2026.** Not yet reviewed by the team.
  - Removed sections 6b (capacity and margin) and 6c (return and customer value estimate) on Josh's decision: their dollar figures rested on an assumed margin and one vendor's figures, and were easy to quote as findings.
  - Adopted the promotion pass rule that compares deal newcomers with other newcomers (section 9).
  - Added that errors compound across days (section 10).
  - Scope before Sunday: the return probe and the "next morning" mode only (header, section 8).
  - Fixed the cross-reference for the owner baseline (section 2).
- **v0.2 draft · Nov 14, 2026.** Added the second research pass. Not yet reviewed by the team.
  - The vendor visit ladder and return timing (section 2b).
  - Three new rows in section 4 (deal reviews, repeated promotions, door signs), and more detail on the Dholakia and Kivetz rows.
  - Figures that did not hold up (section 4b).
  - What the engine has today (section 5b).
  - Three loyalty mechanisms to try first, with a patch (section 6).
  - Capacity and margin for the sushi restaurant, and who a longer line pushes out (section 6b).
  - A first estimate of return and customer value (section 6c).
  - Notes on two level 1 pass rules (section 9) and when a result may be reported (section 9b).
- **v0.1 draft · Nov 14, 2026.** Written from the Nov 14 research pass, with the three-level loyalty benchmark (section 9). Not yet reviewed by the team.
