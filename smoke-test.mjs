import fs from 'node:fs';
import vm from 'node:vm';

const requiredFiles = ['index.html', 'css/style.css', 'js/app.js', 'data/questions.js', 'questions.json'];
const missing = requiredFiles.filter((file) => !fs.existsSync(file));
if (missing.length) {
  console.error(`必要ファイルがありません: ${missing.join(', ')}`);
  process.exit(1);
}

const html = fs.readFileSync('index.html', 'utf8');
for (const asset of ['css/style.css', 'data/questions.js', 'js/app.js']) {
  if (!html.includes(asset)) {
    console.error(`index.html から ${asset} が参照されていません。`);
    process.exit(1);
  }
}

new vm.Script(fs.readFileSync('data/questions.js', 'utf8'));
new vm.Script(fs.readFileSync('js/app.js', 'utf8'));

console.log('OK: 必要ファイルあり、HTML参照あり、主要JS構文チェック成功');
