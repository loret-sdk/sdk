// Post-build: add .js extensions to relative imports in dist/
// Required because tsc with moduleResolution:"Bundler" does not emit extensions,
// but Node ESM requires them.
const fs = require("fs");
const path = require("path");

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  content = content.replace(
    /(from\s+["'])(\.\.?\/[^"']+?)(["'])/g,
    (match, pre, importPath, post) => {
      if (importPath.endsWith(".js") || importPath.endsWith(".d.ts"))
        return match;
      return pre + importPath + ".js" + post;
    },
  );
  fs.writeFileSync(filePath, content);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))
      fixFile(full);
  }
}

walk(path.resolve(__dirname, "../dist"));
