# Handoff: loyalty buttons on the sushi page

Written Nov 14, 2026, late evening, when the first account hit its usage limit. Read this, then continue from "What is left".

## The project in three lines

Swarmscope simulates customers of an independent business. The real case is the **sushi restaurant** the team interviewed (`worlds/sushi-restaurant.json`): eight seats, Friday dinner, no reservations. The only page is the dashboard at `/scope/` (sushi at `/scope/?case=sushi`); Josh owns it. Start it with `PORT=4195 npm run web` and open http://localhost:4195/scope/.

## Where the code is

- Repo: `/Users/joshuakim/Downloads/Projects/hackprinceton` (GitHub `joshuak10/hackprinceton`, public).
- `main` and `origin/main`: `b5b8a8c`.
- Checked out: local branch `loyalty-changes`, one commit ahead of `main` (`2d9cf44`), **not pushed**. 879 tests pass (`npm test`).
- Nothing of the dashboard work below exists yet. An agent was started for it and stopped before writing any file.

## What is already done (do not redo)

- The multi-day loop (`run/days.js`, `node bin/swarm.js days <pool>`): the same diners over 8 Fridays, each asked every week whether they come, remembering what happened. Contract: `docs/PROTOTYPE.md` §21, §21e.
- The sushi restaurant's diners: `pools/sushi-restaurant.json` (every rate is an assumption).
- Jev's memory check in dinner words (§21e): being turned away costs 42 points, a 30-minute wait for a seat 8, a $2 price rise 1, a 20% promotion nothing.
- Two-month results saved in `data/days/sushi.json` (gitignored): the promotion (first-timers who are mostly turned away, no more regulars) and two more counter seats (+4 seated every Friday, regulars unclear).
- On `loyalty-changes`: two new changes for the loop, `faster15` (meals 15% quicker at the counter) and `sorry` (a card for anyone turned away: "sorry we could not serve you last time. Come back within two weeks for a free roll"). The card's words were checked with Jev: a turned-away diner's chance of coming the next Friday is 26% with a plain message and 48% with the card (+22 points, all 8 diners up). This check is **not in the docs yet**.

## What is left, in order

1. **Run the two new changes over two months** (about 40 cents of Jev; the key is in `.env.local`):
   `node bin/swarm.js days pools/sushi-restaurant.json --days 8 --seeds 3 --provider jev --change faster15,sorry --baseline-from data/days/sushi.json --out data/days/sushi-more.json`
2. **Build the dashboard part** on the sushi page:
   - Server: `GET /api/days?pool=pools/sushi-restaurant.json` returns the saved two-month results for that pool, merged across the files in `data/days/` (newest wins for a repeated label). Read-only and path-safe, with tests.
   - Opening state of the sidebar's top panel (it now says how many people did not get a seat and offers "Test the promotion"): one suggestion sentence built from the run on screen ("12 of 36 people did not get a seat. Being turned away is what stops diners coming back, far more than a wait or the price. Try seating more of them before discounting."), then three buttons: **Two more seats**, **Faster turnover at the counter**, **A card for people you turn away**.
   - Pressing a button shows that change's saved result in the same panel, with a way back: a plain headline (state a change only where every seed agrees, `effects.<metric>.agrees`; always say what happened to regulars), a small before → after table with the range (people seated, turned away or gave up, average wait for a seat, first-time visitors, regulars), what a regular is ("came on 2 of the last 4 Fridays"), and one caution line (simulated diners, assumed visit rates, sizes unvalidated: read direction and range).
   - Match buttons to results by label: `/more seat/i`, `/quicker|faster/i`, `/turned away/i`. If a result is not saved on this computer, say so and show the command.
   - Pure logic in a module under `web/scope/lib/` with unit tests; `app.js` only wires it.
   - Do not break: the building page, an existing promotion test, changed rooms, Run details.
3. **Docs:** add the card check and the two new results to `docs/PROTOTYPE.md` §21e; add "§21f. The loyalty buttons on the sushi page"; one change-log entry in `SWARMSCOPE_SPEC.md` (next version after v0.36).
4. **Verify:** `npm test`; drive the page in headless Chrome at 1280×832, light and dark (opening state, each button's result, the building page); no console errors beyond the known 404 for a run's optional `incidents` file.
5. **Push to `main`.** Josh asked for this: "Okay build them. Then push." Fast-forward only; fetch first in case `main` moved.

## Rules that stand

- Never print API keys or `.env.local`. Never commit `.env*`, `data/`, `runs/`, `costar-hackathon-kit/`, or `ssrn-1851643.pdf`. The repo is public.
- Do not commit the local edit to `INDEPENDENT_BUSINESS_SPEC.md` (a stray "1" on line 3).
- No attribution lines in commit messages.
- Design, from Josh: no numbers without the why; must not look like a generic SaaS dashboard (no tile grids, pills, accent buttons); no clutter; plain words (never "seed", "requests", "pool" in the main view). English only. One page.
- Ask before a Jev run estimated over $1.
- Results from the loop are unvalidated in size: report direction and range, and only where every seed agrees.
