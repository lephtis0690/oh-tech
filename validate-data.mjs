import fs from 'node:fs';
import vm from 'node:vm';

const questions = JSON.parse(fs.readFileSync('questions.json', 'utf8'));
const jsText = fs.readFileSync('data/questions.js', 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(jsText + '\nthis.__QUESTIONS__ = QUESTIONS;', context);
const jsQuestions = context.__QUESTIONS__;

const errors = [];
const ids = new Map();

if (!Array.isArray(questions)) errors.push('questions.json が配列ではありません。');
if (!Array.isArray(jsQuestions)) errors.push('data/questions.js の QUESTIONS が配列ではありません。');
if (questions.length !== jsQuestions.length) errors.push(`問題数が不一致です: questions.json=${questions.length}, questions.js=${jsQuestions.length}`);
if (JSON.stringify(questions) !== JSON.stringify(jsQuestions)) errors.push('questions.json と data/questions.js の内容が一致していません。');

questions.forEach((q, index) => {
  const label = q.id || `index:${index}`;
  for (const key of ['id', 'category', 'difficulty', 'question', 'choices', 'answer', 'explanation']) {
    if (!(key in q)) errors.push(`${label}: ${key} がありません。`);
  }
  if (q.id) ids.set(q.id, (ids.get(q.id) || 0) + 1);
  if (!Array.isArray(q.choices) || q.choices.length !== 4) errors.push(`${label}: 選択肢が4つではありません。`);
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) errors.push(`${label}: answer が0〜3の整数ではありません。`);
  if (Array.isArray(q.choices) && new Set(q.choices).size !== q.choices.length) errors.push(`${label}: 選択肢が重複しています。`);
});

for (const [id, count] of ids) {
  if (count > 1) errors.push(`${id}: IDが重複しています。`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`OK: ${questions.length}問、ID重複なし、選択肢4択、answer範囲正常、questions.json / data/questions.js 同期済み`);
