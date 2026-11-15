// Feelings a visitor can give a person with one click (docs/PROTOTYPE.md §17). Each adds one sentence to the
// person's situation and nothing else. The sentences use the person's first name, so they read right for anyone.
// run/room-seed.js records Jev's answer to every one of them for the example world, so they work with no key.
export const FEELINGS = [
  { id: 'good-news', label: 'Got good news', sentence: name => `${name} got very good news this morning and feels like celebrating.` },
  { id: 'awful-morning', label: 'Awful morning', sentence: name => `${name} has had an awful morning and has no patience left for anything today.` },
  { id: 'money-worry', label: 'Worried about money', sentence: name => `${name} just opened a bill that was not expected and is worried about money this week.` },
  { id: 'lonely', label: 'Feeling lonely', sentence: name => `${name} has hardly spoken to anyone in days and would like to see a friendly face.` }
];

export const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'This person';
export const withFeeling = (bio, name, feeling) => `${String(bio || '').trim()} ${feeling.sentence(firstName(name))}`.trim();
