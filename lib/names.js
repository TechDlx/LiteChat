import { randomInt } from 'node:crypto';

const ADJECTIVES = [
  'Amber', 'Brave', 'Brisk', 'Calm', 'Clever', 'Cosmic', 'Crisp', 'Curious',
  'Dapper', 'Eager', 'Electric', 'Fancy', 'Fearless', 'Gentle', 'Golden', 'Happy',
  'Hidden', 'Humble', 'Jolly', 'Keen', 'Lively', 'Lucky', 'Mellow', 'Merry',
  'Mighty', 'Nimble', 'Noble', 'Plucky', 'Polite', 'Proud', 'Quiet', 'Rapid',
  'Royal', 'Rustic', 'Silent', 'Silver', 'Sleepy', 'Smooth', 'Snappy', 'Solar',
  'Spry', 'Steady', 'Sunny', 'Swift', 'Tidy', 'Tiny', 'Vivid', 'Witty'
];

const ANIMALS = [
  'Otter', 'Heron', 'Falcon', 'Badger', 'Panda', 'Lynx', 'Marten', 'Puffin',
  'Raven', 'Gecko', 'Ibis', 'Koala', 'Lemur', 'Magpie', 'Narwhal', 'Ocelot',
  'Osprey', 'Quokka', 'Rabbit', 'Salmon', 'Tapir', 'Toucan', 'Turtle', 'Walrus',
  'Weasel', 'Wombat', 'Yak', 'Zebra', 'Bison', 'Camel', 'Crane', 'Dingo',
  'Egret', 'Ferret', 'Finch', 'Gibbon', 'Hare', 'Jackal', 'Kestrel', 'Llama',
  'Manatee', 'Mongoose', 'Newt', 'Pelican', 'Robin', 'Shrew', 'Stoat', 'Vole'
];

/**
 * Pick a display name that is not already used in `taken`.
 * Falls back to a numbered suffix once the pool is crowded.
 */
export function pickName(taken) {
  for (let i = 0; i < 60; i++) {
    const name = ADJECTIVES[randomInt(ADJECTIVES.length)] + ANIMALS[randomInt(ANIMALS.length)];
    if (!taken.has(name)) return name;
  }
  const base = ADJECTIVES[randomInt(ADJECTIVES.length)] + ANIMALS[randomInt(ANIMALS.length)];
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Stable hue (0-359) derived from a string, used for the member's colour chip. */
export function hueFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}
