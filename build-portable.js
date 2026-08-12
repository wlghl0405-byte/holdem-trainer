/**
 * 단일 파일 배포본 생성 (node build-portable.js)
 * engine.js를 index.html에 인라인해 어느 PC에서든 파일 하나로 실행 가능하게 만든다.
 * 폰트 CDN은 남겨두되, 오프라인이면 시스템 폰트로 자동 폴백된다.
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const engine = fs.readFileSync(path.join(dir, 'engine.js'), 'utf8');

if (!html.includes('<script src="engine.js"></script>')) {
  console.error('engine.js 참조를 찾지 못했습니다. index.html 구조를 확인하세요.');
  process.exit(1);
}

const out = html.replace(
  '<script src="engine.js"></script>',
  '<script>\n/* engine.js 인라인 (build-portable.js 자동 생성) */\n' + engine + '\n</script>'
);

const file = path.join(dir, '홀덤트레이너.html');
fs.writeFileSync(file, out);
console.log(`생성: 홀덤트레이너.html (${(out.length / 1024).toFixed(0)} KB) · 파일 하나만 복사하면 어느 PC에서든 실행`);
