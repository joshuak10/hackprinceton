# Swarmscope for independent businesses: Use-Case Spec

> **Version:** v0.1 · Nov 14, 2026 · HackPrinceton Fall 2026
> **Scope:** only the independent-business product. The project spec, [SWARMSCOPE_SPEC.md](SWARMSCOPE_SPEC.md) (v0.24), records the decision to pursue it. The engine contract, [docs/PROTOTYPE.md](docs/PROTOTYPE.md), still governs the code.
> **Rule:** as in the project spec, change this file first, then the code, and log every decision in section 14.
>
> **Owner data never goes in this public repo.** A business's sales, menu, prices, staff and floor plan stay under `data/` (gitignored) unless the owner agrees in writing to publish them. No customer names, ever.

**Status tags:** `[built]` exists in the repo · `[planned]` decided, not built · `[candidate]` possible, not decided · `[open]` unresolved or unverified.
**Number labels:** `data` (from the owner's records) · `owner-reported` (the owner's estimate) · `assumed` (ours) · `measured` (we ran it).

---

## 1. The product in one paragraph

**Try a change on a simulated version of your customers before you try it on your real ones.**

An independent café owner who wants to raise a price, drop a menu item, change opening hours, add someone on the register at lunch or move the pickup counter usually has two options: guess, or do nothing. Swarmscope builds a small simulated copy of their shop from their own numbers. That copy has their menu, their hours, their busy times and the kinds of customers they actually get. Hundreds of simulated customers, each deciding through Jev, then live through several weeks with and without the change. The owner gets a plain answer in minutes for a few dollars at most: what happens to sales and waits, which customers would leave or come more often, and the smallest trial to run in real life to check it.

---

## 2. The problem

Independent owners face a decision problem that larger businesses do not:

- **No budget for help.** A consultant, a pricing study or an analyst is out of reach for a single shop. `[open]` confirm with owners what they have paid for, if anything.
- **One location, so no experiments.** A chain can try a change in ten stores and compare. A single shop can only change itself, and every customer sees it.
- **Regulars notice everything.** A large share of a café's sales can come from people who visit several times a week. Losing a few of them is visible and slow to undo. `[open]` the regular share is to be confirmed per business.
- **Thin margins.** A wrong price or a slower lunch line can cost more than the change was meant to gain.

So owners often do nothing, even when a change would help. Here is what they rely on today:

| What they use | Why it falls short |
|---|---|
| Gut feel and asking regulars | Biased toward the loudest customers; says nothing about people who quietly stop coming |
| Point-of-sale reports (Square, Toast, Clover) | Show what already happened; cannot show what a change would do |
| Generic AI chat advice | Gives opinions without the shop's numbers or customers, and tests nothing |
| A consultant | Too expensive for one shop |

`[open]` These are our working assumptions. Section 11 makes confirming them with a real owner the first task.

---

## 3. Who it is for

**First: counter-service food and drink.** Cafés, bakeries, sandwich shops, bubble-tea and ice-cream shops.
- Every lever in section 4 applies: prices, menu, hours, staffing at the rush, layout and where the line forms.
- Regulars are common, which is exactly why owners fear change.
- Most take card payments through a point-of-sale system that can export sales, so calibration data usually exists.
- There are many near campus (Nassau Street and Witherspoon Street) to consult during the hackathon.

**Later:** appointment businesses such as barbers, salons and small studios, where pricing, hours and booking rules matter. After that, small retail.

**Not for:**
- Chains with analytics teams, which can test across their own stores.
- Online-only businesses, which can A/B test cheaply and should.
- Manipulative design. We help owners make changes their customers accept. We do not help hide prices or trap customers.

---

## 4. Decisions it answers

Only decisions where **customers' reactions are the risk**. Rent, suppliers and advertising campaigns are out of scope.

| Decision | Example question | What the engine has today | Gap |
|---|---|---|---|
| Price | "If I raise the latte by 50 cents, do I lose regulars?" | `[built]` a price per place (`nodes[].price`, patchable), price words in what agents see, discounts aimed at groups (`offers[].priceOff`) | `[planned]` prices per menu item; a memory of the old price across visits |
| Menu | "What happens if I drop the tuna sandwich and add a cold brew?" | `[built]` a place's description (`about`) shapes choices: on the real building, Jev's customers avoided a counter described as "great food, slow kitchen" | `[planned]` menu items inside a place, each with a price, a prep time and a description |
| Staffing at the rush | "Is a second person on the register from 12 to 1 worth it?" | `[built]` `servers` and `serviceTime`, patchable; lines, waiting and walking away | `[planned]` staff by time of day |
| Hours | "Should I open at 6:30 instead of 7?" | `[built]` arrival window (`arrivals.start`, `arrivals.end`) | `[planned]` opening hours per place; a day longer than 24 hours of simulated time (`duration` is 30 to 1,440 minutes) |
| Layout | "If I move the pickup shelf by the door, does the line stop blocking the entrance?" | `[built]` walls, doors and solid objects; nobody walks through them (project spec v0.15, v0.23) | `[planned]` a simple floor-sketch input instead of a Matterport scan |
| Competition | "If my wait goes up, where do people go instead?" | `[built]` a "leave" option with a label (`leaveLabel`) | `[planned]` named nearby alternatives as places outside the shop |

---

## 5. The edge, honestly

**What makes it quick and cheap** (`measured` on our engine, Nov 14):
- Jev decisions are fast and cheap. A 560-person emergency-room world made 1,276 Jev requests in 57 s for about $0.05. The real building, with 312 people on five seeds, made 4,725 requests in 70 s for about 30 cents. Prices use TypeSafe's published rate and are `[open]` (unverified).
- At the real building's rate, one simulated day on one seed is about 950 Jev requests, 6 cents and 14 seconds. Two simulated weeks on five seeds is 70 such days: roughly $4 and 16 minutes run one after another. That is an estimate from the measured rate, not a measurement, and a café with fewer customers costs less. Repeat visits may add requests per person. `[open]` The Claude calls that build the world and write the advice cost more and are not yet measured.
- The owner talks in plain words. Claude builds the world (`compile/compile.js`, `compileWorld`), and the advisor (`run/advisor.js`) tests the change and writes the answer.

**What makes it worth trusting:** quick and cheap alone is dangerous, because a cheap wrong answer can push an owner into a bad change. So the edge is four things together:
1. **Quick:** minutes, not weeks.
2. **Cheap:** cents for one simulated day, a few dollars for several weeks.
3. **Their shop:** built from the owner's own numbers, and checked against them before any question is answered (section 7).
4. **Who, not just how many:** the answer names which kinds of customers leave or come more often. The engine already reports results by kind of person (`run/effects.js`).

**What it does not buy:** a forecast. Results are ranges under stated assumptions, and each one ends with a small real-world trial to confirm it.

---

## 6. How it works for the owner

1. **Intake (about 15 minutes).** `[planned]` A conversation or short form:
   - menu items, prices and rough prep times;
   - opening hours, and staff by time of day;
   - busy times, and roughly how many customers per hour;
   - who the customers are (students, office workers, families, regulars versus passers-by);
   - nearby alternatives;
   - optionally, a point-of-sale export (CSV) and a photo or sketch of the floor.

   Every number is labelled `data`, `owner-reported` or `assumed`.
2. **"Your shop" is built.** `[built]` in part: `compileWorld` turns a description into a world, with places, customer groups and a cast of named people, each with their own situation. `[planned]` menu items, hours, regulars and alternatives.
3. **The calibration check (section 7).** A simulated ordinary day is compared with the owner's numbers. If it does not match, the inputs are adjusted and the check runs again.
4. **The owner asks.** "What if I raise the latte by 50 cents?" in plain words.
5. **The change is tested.** `[built]` The advisor runs the change on the same simulated customers and seeds as the baseline and reports the difference with its spread across seeds. `[planned]` over several simulated weeks, with regulars who remember.
6. **The report (section 8).**
7. **The trial.** Each recommendation ends with the smallest reversible version to try. For example: raise one item's price for two weeks, or add a second register only on Tuesdays and Thursdays.
8. **Follow-up.** `[planned]` The owner's next sales export is compared with what the simulation predicted. This is how the product earns trust and collects validation data.

---

## 7. Trust: the calibration gate

No question is answered until the simulated ordinary day matches the owner's numbers closely enough.

| Compared | Source | Must match within |
|---|---|---|
| Customers per hour, busiest three hours | point-of-sale export or owner's estimate | ±15% `[open]` threshold to tune |
| Sales per day | point-of-sale export or owner's estimate | ±10% `[open]` |
| Share of the top five items | point-of-sale export | ±5 percentage points `[open]` |
| Longest line at the rush | owner's estimate | same rough size (for example "about 8 people") |

- If the owner has made a price change before, the simulation re-runs it and must show the same direction of change in sales.
- The report always says how good the match was and which inputs are `owner-reported` or `assumed`.
- Results are ranges across seeds, never a single number, and a claim that changes direction between seeds is reported as uncertain.

---

## 8. What the owner sees

`[planned]` A one-page report written for the owner, not the projector display used for the building demo:
- **The answer in one sentence.** For example: "Raising the latte by 50 cents adds about $X a week; about N of your regulars come less often, mostly students."
- **Money per week**, with a range.
- **Customers lost or gained**, by kind of customer.
- **Wait times at the rush**, before and after.
- **Confidence:** does it hold across seeds, and how good was the calibration match?
- **What we could not test.**
- **The trial to run,** and what to watch in the sales data.

The replay map (`web/scope/`) stays available as a "see it happen" view for the pitch, but the report is the product.

---

## 9. What we reuse and what we build

**Reuse** `[built]`:
- The engine: visit mode, places with lines, prices, walking away, word of mouth, walls, doors and objects (`engine/`).
- The Jev provider and its rules fallback (`providers/`).
- Recording and replay (`run/recorder.js`).
- The advisor, which tests changes on the same seeds (`run/advisor.js`), and results by kind of person (`run/effects.js`).
- The world compiler (`compile/compile.js`).
- Patchable levers (`PATCH_FIELDS` in `engine/spec.js`): place `servers`, `serviceTime`, `appeal`, `price`, `weight`; group `info`, `patience`, `rationality`, `visits`, `share`; arrival window and total; offers.

**Build** `[planned]`, most important first:
1. **Repeat visits with memory.** Simulate several weeks. A regular remembers past visits ("last Tuesday I waited 12 minutes"; "the latte went up 50 cents") and decides each day whether to come. Word of mouth carries between regulars. This answers the owner's real fear, so it comes first.
2. **Menu items.** A place has items, each with a price, a prep time and a description. A customer picks items through Jev, and the items set the service time and the sale.
3. **Opening hours and staff by time of day.**
4. **Nearby alternatives** as places outside the shop, so "leave" has a destination.
5. **Point-of-sale import.** A CSV becomes arrivals per 15 minutes, item mix and average ticket, for both building the world and the calibration gate.
6. **Owner intake and the one-page report.**
7. **A floor-sketch input** for layout questions (a rectangle, a door, a counter, seats), using the existing walls and objects.

---

## 10. Data and privacy

- Owner data (sales exports, menus, prices, staff, floor sketches) is stored under `data/` and is never committed. The repo is public.
- Customer names and card details are never imported. A sales export is reduced to times, items and totals before it is read.
- Published examples use a fictional shop, or a real one only with the owner's written permission.

---

## 11. Hackathon scope (by Sunday's submission)

**Goal:** one real independent business near campus, consulted in person, with one recommendation they could adopt immediately.

1. **Find the business** (first task). A counter-service food or drink shop near campus whose owner or manager will talk for 15 minutes. Record their name, their role, and one piece of evidence: a sales export, a photo of the menu with prices, or a written quote about a decision they are unsure of.
2. **Pick two questions at most,** from the owner's own words. One price or menu question and one rush-hour staffing or layout question is the ideal pair.
3. **Build their shop** with the owner's numbers, labelled by source, and pass the calibration gate (section 7) as far as their data allows.
4. **Answer the questions** with the advisor on the same seeds, as ranges, with results by kind of customer.
5. **Hand over a one-page report** and the suggested trial, and get the owner's reaction in their own words.

**Build order this weekend:** menu items, then repeat visits over one simulated week, then the report page. If time runs short, cut in this order:
- multi-week memory (keep one week);
- the point-of-sale import (use owner estimates);
- the floor sketch (skip layout questions).

---

## 12. Tracks

- **Peri (Forward Deployed Challenge), primary.** It rewards a real-world need, whether the business could adopt the result immediately, and end-to-end execution. It requires the business's name, the person consulted and their role, and one piece of evidence. Section 11 produces all three. Student orgs and clubs also qualify.
- **Amazon (Best Practical AI Innovation).** It favours AI that reasons, plans, takes several steps and adapts. The advisor's test-and-revise loop and the follow-up check fit that.
- **LangChain (Deep Agents).** It applies if the intake and advisor run as a deep agent.
- **CoStar** is `[open]` (see the project spec, section 10).

---

## 13. Risks and open questions

1. **Simulated customers are not validated.** Mitigation: the calibration gate, ranges across seeds, the real-world trial, and follow-up against the next sales export.
2. **Price realism.** Simulated customers may react to prices more or less than real ones. Calibrate on a past price change when there is one, and report the direction more confidently than the size.
3. **Small numbers.** A small shop has few customers, so the results are noisy. Use more seeds and more simulated days, and report ranges.
4. **Owner time and data.** Some owners will not export sales data. Then the product runs on estimates, says so, and suggests what to count for a week.
5. **Breadth.** "Every business decision" is too wide. Section 4 limits it to decisions where customers' reactions are the risk.
6. **Cost of the Claude calls.** Building the world and writing the advice cost more than Jev and are not measured yet. `[open]`
7. **Willingness to pay.** `[open]` Is it a subscription, a price per question, or bundled with a point-of-sale system? Not needed for Peri, but needed for a business.
8. **Trust and liability.** The product never presents results as a guarantee, and every answer ends with a reversible trial.
9. **Engine work.** Repeat visits with memory, menu items and opening hours are new engine features (section 9). They follow the project spec's rule: spec first, then code, with tests.

---

## 14. Change log

- **v0.1 · Nov 14, 2026.** First version. The team chose independent local businesses as the product's audience, with counter-service food and drink first. Recorded:
  - the problem and today's alternatives, as assumptions to confirm with owners;
  - the decisions in scope;
  - the edge (quick, cheap, their shop, who leaves) and what it does not buy;
  - the owner flow, the calibration gate and the report;
  - what we reuse and what we build;
  - the hackathon scope for the Peri track;
  - the risks.
