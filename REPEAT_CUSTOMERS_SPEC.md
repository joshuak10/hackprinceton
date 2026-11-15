# Swarmscope: new and returning customers over days (draft spec)

> **Version:** v0.1 draft · Nov 14, 2026 · HackPrinceton Fall 2026
> **Scope:** item 1 of [INDEPENDENT_BUSINESS_SPEC.md](INDEPENDENT_BUSINESS_SPEC.md) §9, "Repeat visits with memory", worked out in detail. Nothing here is built. The engine contract, [docs/PROTOTYPE.md](docs/PROTOTYPE.md), still governs the code; when this is approved, its engine parts go there as a new section before any code.
> **Source:** a research pass on Nov 14 (one research agent, web sources listed in section 10). The published figures were gathered from papers, abstracts and summaries and have not all been checked against the full papers. Treat each as "to confirm" until someone reads the source.

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
- First-to-second visit: the share of first-timers who come back. Vendor figures put this at roughly 7 to 23% for restaurants without marketing (weak source; direction only).

**Loyalty**
- Return within 7 and within 30 days.
- Visits per customer per week, and the gap between visits.
- Regulars: people with 3 or more visits in 2 weeks (threshold `[open]`).
- Dropout: people not seen for N days.
- Word of mouth: good remarks minus bad ones, counted from what simulated people say, not a survey score.

These match the standard repeat-visit model, BG/NBD (Fader, Hardie & Lee 2005): each person has a visit rate and a chance of dropping out after each visit. An owner's point-of-sale export can be fitted to that model, which gives a real baseline to check the simulation against (section 8).

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
| A promotion or discount | Dholakia 2011 (324 businesses): about 80% of deal buyers were new, and about 20% (19.9%) came back at full price. | Medium. A survey of businesses. Relevant to the sushi promotion. |
| Stamp-card progress | Kivetz, Urminsky & Zheng 2006: the gap between purchases shrinks about 20% (0.7 days) as a café customer nears a free drink. Nunes & Drèze 2006: a card given with 2 free stamps was completed 34% of the time, against 19%. | Strong field experiments. |
| Long waits (vendor data) | uKnomi 2024 (drive-through): more than 1 in 3 repeat customers did not return within 90 days when service took over 10 minutes. | Weak; the vendor sells this analysis. Direction only. |

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

## 6. Changes to test, and the report

Changes: staff, price, a promotion, a stamp card, seats. Each is an existing lever or offer. Each runs over 1 to 2 simulated weeks on several seeds, against the same weeks without the change.

The owner reads, as ranges: "+N new customers a week, M more regulars", split by kind of customer (for example lunch-break workers, students, regulars).

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

## 9. Benchmark: how we test loyalty

No ready-made benchmark exists for simulated customers' loyalty. We test in three levels. The first two are gates; the third is the real test.

**Level 1: signal tests** (the return probe, section 8). Each has a pass rule from a published study (section 4):

| Test | Pass if the simulation shows |
|---|---|
| Last wait → coming back (de Vries et al. 2018) | The chance of returning falls as the last wait gets longer, and people who walked away return less than people who were served. |
| Price change (Hardie et al. 1993) | A 50-cent rise lowers returns more than a 50-cent cut raises them. |
| Stamp card, near the reward (Kivetz et al. 2006) | Visits come about 10–30% closer together at 8 of 10 stamps than at 2 of 10 (study: about 20%). |
| Stamp card, head start (Nunes & Drèze 2006) | A card that starts with 2 free stamps is finished clearly more often (study: 34% against 19%). |
| Promotion (Dholakia 2011) | Of the newcomers a 20%-off deal brings, roughly 10–30% come back at full price (study: about 20%). |
| Star rating (Luca 2016) | A higher rating brings more first-time visitors, around the 5–9% revenue gain per star. |

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

## 10. Caveats and open questions

- **Most published effects are not one person's probabilities.** They are totals (revenue, sell-outs, time until the next visit). We can match direction and rough size, not exact values.
- **Noise adds up over days.** Two Jev runs of the same world and seed already differ by a few people, so multi-day results need several seeds and are reported as ranges.
- **The baseline needs the owner's data:** the share of repeat customers and visits per regular, from point-of-sale or stamp-card records. Without it, loyalty numbers are directional only. Owner data never goes in this public repo ([INDEPENDENT_BUSINESS_SPEC.md](INDEPENDENT_BUSINESS_SPEC.md) §10).
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

## 12. Change log

- **v0.1 draft · Nov 14, 2026.** Written from the Nov 14 research pass, with the three-level loyalty benchmark (section 9). Not yet reviewed by the team.
