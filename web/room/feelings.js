// Feelings a visitor can give a person, or the whole room, with one click (docs/PROTOTYPE.md §17). Each adds one
// sentence to the person's situation and nothing else. The sentences use the person's first name, so they read
// right for anyone. Two are about the shop itself, because a feeling aimed at the place moves people far more
// than a general mood does. run/room-seed.js records Jev's answer to every one of them for the example world,
// at the opening moment, with a long line and at a higher price, so they work with no key.
export const FEELINGS = [
  { id: 'kindness', label: 'Treated kindly here', today: 'still touched by a kindness here',
    sentence: (name, shop) => `Yesterday someone working at ${shop} remembered ${name}'s name and went out of the way to be kind, and ${name} was touched.` },
  { id: 'brushed-off', label: 'Brushed off here', today: 'still hurt at being brushed off here',
    sentence: (name, shop) => `${name} felt brushed off by the staff at ${shop} yesterday and is still hurt about it.` },
  { id: 'lonely', label: 'Feeling lonely', today: 'feeling lonely',
    sentence: name => `${name} has hardly spoken to anyone in days and would like to see a friendly face.` },
  { id: 'money-worry', label: 'Worried about money', today: 'worried about money',
    sentence: name => `${name} just opened a bill that was not expected and is worried about money this week.` },
  { id: 'awful-morning', label: 'Awful morning', today: 'having an awful morning',
    sentence: name => `${name} has had an awful morning and has no patience left for anything today.` }
];

export const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'This person';
export const withFeeling = (bio, name, feeling, shop = 'this shop') => `${String(bio || '').trim()} ${feeling.sentence(firstName(name), shop)}`.trim();
