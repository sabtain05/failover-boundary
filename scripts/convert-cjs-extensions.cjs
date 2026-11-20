const fs = require('fs');
const path = require('path');

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!fullPath.endsWith('.js')) {
      continue;
    }

    const contents = fs.readFileSync(fullPath, 'utf8');
    const rewritten = contents.replace(
      /require\((['"])(\.[^'"]*?)\.js\1\)/g,
      (_, quote, importPath) => `require(${quote}${importPath}.cjs${quote})`
    );

    fs.writeFileSync(fullPath.slice(0, -3) + '.cjs', rewritten);
    fs.unlinkSync(fullPath);
  }
}

walk('dist/cjs');
