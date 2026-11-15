// One day or several? (docs/PROTOTYPE.md §21d)
//
// A one-day run and a multi-day run start their people differently. In a one-day run every arrival is a new
// copy of a cast member with no past, drawn at random. In a multi-day run (run/days.js) the same people persist
// in a pool, each with a usual visit rate and a memory, and are asked every morning whether they come. So a
// question about coming back cannot be answered by a one-day run, and a question about one rush does not
// need the pool. This module is the one place that rule is written, for the advisor and for any page.

// The rule in words, given to the advisor model and to people.
export const TIMESCALE_RULE = [
  'There are two kinds of test, and the question decides which.',
  'A one-day test plays one day with a fresh crowd. Use it for what happens on the day: lines, waits, walk-aways, where people go, staffing at a rush, layout, an offer made that day.',
  'A test over days plays the same people for two weeks. Each of them decides every morning whether to come, remembering what happened to them. Use it when the answer is about later days: whether people come back, regulars and loyalty, new customers finding the place, word of mouth, a price change people remember, what a promotion leaves behind, a stamp card.',
  'A test over days needs a pool (who the regular customers are and how often each kind comes) and Jev (the rule model does not read memory). It costs far more than a one-day test and its sizes are unvalidated, so state its results as direction and range.'
].join(' ');

const OVER_DAYS = [
  /\bcom(e|es|ing) back\b/, /\breturn(s|ed|ing)?\b/, /\bregulars?\b/, /\bloyal(ty)?\b/, /\brepeat\b/, /\bretention\b|\bretain\b/, /\bchurn\b|\blapse/,
  /\bnew customers?\b/, /\bfirst[- ]tim(e|ers?)\b/, /\bword of mouth\b/, /\bstamp ?card\b|\bloyalty card\b|\bpunch ?card\b/,
  /\b(next|over|after|in) (a |the |two |three |\d+ )?(weeks?|months?|days?)\b/, /\bweek(s|ly|long)?\b/, /\bmonth(s|ly)?\b/, /\blong[- ]term\b|\bover time\b|\bin the long run\b/,
  /\bkeep (my |our |their )?customers\b|\blose (my |our |their )?customers\b|\bdrive .* away\b|\bstop coming\b/, /\bhabit\b/, /\breputation\b/
];

// 'days' when the question is about later days, otherwise 'day'. A keyword rule: transparent, the same every
// time, and wrong sometimes. The advisor model reads TIMESCALE_RULE and decides for itself; this is the check
// a page can make without a model.
export function timescaleOf(question) {
  const text = String(question ?? '').toLowerCase();
  const hit = OVER_DAYS.find(re => re.test(text));
  return hit ? { scale: 'days', matched: text.match(hit)[0] } : { scale: 'day', matched: null };
}
