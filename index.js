#! /usr/bin/env node

const path = require('path');
const util = require('util');
const _ = require('lodash');
const graphviz = require('graphviz');
const DataURI = require('datauri');
const convert = require('color-convert');
const {ShellString, cp, mkdir, exec, which, cat} = require('shelljs');
const yargs = require('yargs');
const chalk = require('chalk');
const fs = require('fs');
const url = require('url');

// specify and parse CLI args
const argv = yargs
  .options({
    'quiet': {
      default: false,
      alias: 'q'
    },
    'show-size': {
      default: false,
      desc: 'Show sizes of modules and chunks'
    },
    'color-by-size': {
      default: false,
      desc: 'Color modules by size to find potentially problematic modules.'
    },
    'show-exports': {
      default: false,
      desc: 'Show provided module exports'
    },
    'show-hashes': {
      default: true,
      desc: 'Show hash values for chunk and compilation.'
    },
    'show-sources': {
      default: false,
      desc: 'Hover over modules to see source code and click to open new tab with source code using data URLs.'
    },
    'show-files': {
      default: true,
      desc: 'Show chunk to file relationships.'
    },
    'show-dep-type': {
      default: false,
      desc: 'Show type of import on module edges.'
    },
    'show-query-string': {
      default: false,
      desc: 'Show query string on request inlined loaders'
    },
    'big-graph-threshold': {
      default: 100,
      desc: 'Number of modules to consider a graph large. Above this threshold the graph will be optimized for a large number of modules. For example, to switch edge type to avoid long rendering times.'
    },
    'output-folder': {
      default: 'statsgraph',
      desc: 'Folder for generated files: graph.svg, graph.dot, interactive.html'
    },
    'archive-graphs': {
      default: true,
      desc: 'Write all files to output-folder/archive/<stats.hash>, this is useful to build a history of graphs to compare. An index is cataloged in output-folder/archive/index.html',
    },
    'hide-pattern': {
      default: false,
      desc: 'A JavaScript regular expression string (case-insensitive) used to hide dependencies, thereby reducing clutter in the resulting graph.'
    },
    'common-basenames-pattern': {
      default: undefined,
      description: 'A JavaScript regular expression string (case-insensitive) used to match common filenames and folders, so that the resulting graph can add additional file path fragments to clarify which file/s are pictured.'
    },
    graphviz: {
      default: 'dot',
      description: 'The Graphviz layout algorithm to use: either dot, neato, fdp, sfdp, twopi or circo. See http://www.graphviz.org/#roadmap for more details.'
    },
    'extra-clusters-pattern': {
      default: undefined,
      description: 'A JavaScript regular expression string (case-insensitive) used to cluster modules that are not located within a node_modules folder.'
    }
  })
  .help()
  .argv;

const quiet = argv.quiet;

const showSize = argv.showSize;
const colorBySize = argv.colorBySize;
const turnYellowAt = 1 / 10 * 1024;
const turnOrangeAt = 1024;
const turnRedAt = 2.5 * 1024;

const bigGraphModuleThreshold = argv.bigGraphThreshold;

const showExports = argv.showExports;
const showChunkHash = argv.showChunkHash;

const showModuleSourceInNodeUrl = argv.showSources;
const showModuleSourceInNodeTooltip = argv.showSources;
const showDependencyTypeAsEdgeLabel = argv.showDepType;
const showQueryString = argv.showQueryString;

const showAssets = argv.showFiles;

const hideRegex = argv.hidePattern ? new RegExp(argv.hidePattern, 'i') : undefined;

const commonBasenamesRegex = argv.commonBasenamesPattern
  ? new RegExp(argv.commonBasenamesPattern, 'i')
  : undefined;

const extraClustersRegex = argv.extraClustersPattern
  ? new RegExp(argv.extraClustersPattern, 'i')
  : undefined;

const needsReadableBasename = (/** @type {string} */ filePath) => {
  return !commonBasenamesRegex || commonBasenamesRegex.test(filePath);
};

const createReadableBasename = (/** @type {string} */ filePath) => {
  if (!commonBasenamesRegex) return filePath;

  const pathSplit = filePath.split(path.sep).reverse();
  let finalName = '';
  for (const pathFragment of pathSplit) {
    finalName = path.join(pathFragment, finalName);
    if (!commonBasenamesRegex.test(finalName)) break;
  }
  return finalName;
}

// COLORS:
const redHue = 0;
const greenHue = 105;
const orangeHue = 35;
const turquoiseHue = 180;
const blueHue = 225;
const yellowHue = 60;
const purpleHue = 260;
const tsBlueHue = 211;
const brownHue = 30;

const doNothing = m => m;
const error = message => console.log(chalk.bold.red('ERROR: ' + message));
const warn = quiet
  ? doNothing : message => console.log(chalk.keyword('orange')('WARNING: ' + message));
const info = quiet
  ? doNothing : message => console.log(message);

if (!which('dot')) {
  error('This script requires the dot executable\nPlease make sure graphviz (http://www.graphviz.org/Download.php) is installed and the bin directory, which contains dot, is in the path.');
  process.exit(1);
}

// resolve files and write files relative to current working directory so we can make this a global command
const dir = process.cwd();

// accept passed stats.json file or look for stats.json default
const relativeStatsFile = argv._[0] || 'stats.json';
const statsFile = path.resolve(dir, relativeStatsFile);
info(`Reading stats from ${relativeStatsFile}`);

if (!fs.existsSync(statsFile)) {
  error(`File not found for stats: ${statsFile}`);
  process.exit(1);
}
const stats = JSON.parse(cat(statsFile));
const bigGraph = stats.modules.length > bigGraphModuleThreshold;
if (bigGraph) {
  warn(`Detected a large graph with ${stats.modules.length} modules, edges will be curvy instead of straight.`);
}

const graph = buildGraph(stats);

const relativeOutputDirectory = argv.outputFolder;
const outputDirectory = path.join(dir, relativeOutputDirectory);
info(`Writing files to ${relativeOutputDirectory}`);
mkdir('-p', outputDirectory);

const dotFile = path.join(outputDirectory, 'graph.dot');
ShellString(graph.to_dot()).to(dotFile);

const svgFile = path.join(outputDirectory, 'graph.svg');
// I was using graphviz to call dot but it didn't fail gracefully so I'm calling the command directly.
// this needs adjusted if you use a different type of graph layout (not dot)
const renderSvg = exec(`${argv.graphviz} -Tsvg -o ${svgFile} ${dotFile}`);
if (renderSvg.code !== 0) {
  error('Render SVG failed');
  process.exit(1);
}

const pdfFile = path.join(outputDirectory, 'graph.pdf');
// I was using graphviz to call dot but it didn't fail gracefully so I'm calling the command directly.
// this needs adjusted if you use a different type of graph layout (not dot)
const renderPdf = exec(`${argv.graphviz} -Tpdf -o ${pdfFile} ${dotFile}`);
if (renderPdf.code !== 0) {
  error('Render PDF failed');
  process.exit(1);
}

const svg = cat(svgFile);
const svgDatauri = new DataURI();
svgDatauri.format('.svg', svg);
const htmlFile = path.join(outputDirectory, 'interactive.html');
ShellString(interactiveHtml(svgDatauri.content)).to(htmlFile);

if (argv.archiveGraphs) {
  // todo if hash exists in archive, we should error if files are different, or just ignore if same
  const archiveDirectory = path.join(outputDirectory, 'archive');
  const hashDirectory = path.join(archiveDirectory, stats.hash);

  info(`Writing archive files to ${hashDirectory}`);
  mkdir('-p', hashDirectory);
  cp(dotFile, path.join(hashDirectory, 'graph.dot'));
  cp(svgFile, path.join(hashDirectory, 'graph.svg'));
  cp(htmlFile, path.join(hashDirectory, 'interactive.html'));
  cp(statsFile, path.join(hashDirectory, 'stats.json'));
  // todo move more logic to archive and break out more modules
  require('./archive')(stats, archiveDirectory);
}

function styleModuleNode(node, m) {
  // note - example wise this is an opportunity for pattern matching with babel transform?
  // https://github.com/tc39/proposal-pattern-matching
  // when I add a build to this, add in babel and pattern matching

  function fillColorByFileExtension() {
    switch (m.fileExtension) {
      case '.html':
        return turquoiseHue;
      case '.css':
        return purpleHue;
      case '.png':
        return orangeHue;
      case '.js':
        return greenHue;
      case '.ts':
      case '.tsx':
        return tsBlueHue;
      default:
        return yellowHue;
    }
  }

  function fillColorBySize() {
    if (m.size < turnYellowAt) {
      return greenHue;
    }
    else if (m.size < turnOrangeAt) {
      return yellowHue;
    }
    else if (m.size < turnRedAt) {
      return orangeHue;
    }
    else {
      return redHue;
    }
  }

  const fillColorHue = colorBySize ? fillColorBySize() : fillColorByFileExtension();
  setNodeColors(fillColorHue, node);
}

function setNodeColors(fillColorHue, node) {
  const fillColorHsl = [fillColorHue, 58, 85];
  node.set('fillcolor', hslToGraphvizHsv(fillColorHsl));

  const borderColorHsl = [fillColorHue, 58, 45];
  node.set('color', hslToGraphvizHsv(borderColorHsl));

  const textColorHsl = [fillColorHue, 95, 18];
  node.set('fontcolor', hslToGraphvizHsv(textColorHsl));
  node.set('style', 'filled');
}

function hslToGraphvizHsv(hsl) {
  const hsv = convert.hsl.hsv(hsl);

  // graphviz format for HSV:
  // "H[, ]+S[, ]+V" where values are from 0 to 1
  const formatted = [
    hsv[0] / 360,
    hsv[1] / 100,
    hsv[2] / 100
  ].join(',');
  return formatted;
}

function showModule(m) {
  if (m.fileExtension === '.png') {
    // allow background card image - is used in two spots and serves as an interesting example of css -> png dep and js -> png dep.
    // note that this is the script I'm using for my course, it's not meant for general purpose usage yet
    return m.name.endsWith('b1fv.png')
      // allow a few other images to show (1.png, 2.png) for illustrative purposes but hide rest to avoid overwhelming number of card images
      || !m.label.match(/(\d\d|[A-z]|[3456789])\.png$/);
  }
  if (hideRegex && hideRegex.test(m.name)) return false;
  return true;
}

/** Hide the module if it has zero visible issuers */
function showModulePassTwo(m, _, modules) {
  if (m.reasons.find(r => r.type === 'entry')) return true;

  const uniqueIssuerGraphIds = [...new Set(m.issuers.map(issuer => issuer.graphId))];
  for (const graphId of uniqueIssuerGraphIds) {
    if (modules.find(module => module.graphId === graphId)) {
      return true;
    }
  }
  return false;
}

function dependencyDisplayText(dep) {
  // this needs work
  switch (dep.type) {
    case 'harmony import':
      return 'esm';
    case 'require import':
      return 'require';
    case 'cjs require':
      return 'cjs';
  }
  return dep.type.replace(' ', '');
}

function parseModule(m) {
  // Understanding node's path module helps with the following code:
  // https://nodejs.org/api/path.html

  // determine if module is a node_module npm package
  // yes I know this is confusing because we also use graph nodes to represent modules :)
  // split out inline loaders - a loader in the module request
  /** @type {string[]} */
  const splitLoadersFromName = m.name.split('!');
  // last item is name even if no loaders
  const nameWithoutLoaders = splitLoadersFromName[splitLoadersFromName.length - 1];
  const packageDetails = {};
  const isNodeModule = nameWithoutLoaders.includes('node_modules');

  if (isNodeModule) {
    // say we have this package: "./node_modules/style-loader/lib/urls.js"

    // then package name is style-loader
    // match both scoped and not package names
    // regex tester: https://regex101.com
    const extractPackageDetails = nameWithoutLoaders.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)\/(.*)/);
    packageDetails.name = extractPackageDetails ? extractPackageDetails[1] : '';
    // and filePath is lib/urls.js
    packageDetails.filePath = extractPackageDetails ? extractPackageDetails[2] : '';
  } else if (extraClustersRegex && extraClustersRegex.test(nameWithoutLoaders)) {
    const nameMatch = nameWithoutLoaders.match(extraClustersRegex);
    if (nameMatch) {
      packageDetails.name = nameMatch[1] || nameMatch[0];
      if (packageDetails.name.length > 0) {
        packageDetails.filePath = nameWithoutLoaders.split(packageDetails.name).reverse()[0].replace(/^\//, '');
        debugger;
      }
    }
  }
  // and filename is urls.js
  packageDetails.filename = packageDetails.filePath ? path.basename(packageDetails.filePath) : '';

  // context import detection
  // todo need to add more context detection for other context examples - this works for my course
  const isContextImport = _.some(m.reasons, r => r.type === 'import() context eager');

  function moduleDisplayText() {

    if (isNodeModule) {
      return createReadableBasename(
        path.join(packageDetails.name, packageDetails.filePath) ||
        m.name
      );
    }

    const hasLoaders = m.name.includes('!');
    if (hasLoaders) {
      // note - file collisions can happen by stripping folders:
      // show multi line label with one loader per line, and last line is file name, all stripped of paths
      return splitLoadersFromName
        .map(l => {
          const request = url.parse(l);
          const query = request.query;
          // todo what about:
          // import whatever from 'http://what.com/whatever.js'
          pathname = request.pathname;
          // todo show query if requested

          if (pathname.includes('node_modules/')) {
            const loaderPackageName = pathname.match(/node_modules\/([^\/]*)/);
            const showPackageName = loaderPackageName ? loaderPackageName[1] : '';
            const showFile = path.basename(pathname);
            if (!showPackageName) {
              return showFile;
            }
            const uninformativeNames = ['index.js', 'loader.js'];
            if (showFile === showPackageName
              || uninformativeNames.includes(showFile)) {
              return showPackageName;
            }
            return showPackageName + ' - ' + showFile;
          }
          else if (needsReadableBasename(path.basename(pathname))) {
            // Improve label formatting for common filenames like index.js or styled.js
            return createReadableBasename(pathname);
          }
          else {
            return path.basename(pathname);
          }
        })
        .join('!\n');
    }
    else if (m.name.includes(' eager ')) {
      // this just happens to be a nicer way to show context import for my card images:
      return m.name.replace(' eager ', '\neager\n');
    }
    else if (isContextImport) {
      return 'unhandled context import: ' + m.name + '\n please consider adding code for this case';
    }
    else if (needsReadableBasename(path.basename(m.name))) {
      // Improve label formatting for common filenames like index.js or styled.js
      return createReadableBasename(m.name);
    }
    // note - file collisions can happen by stripping folders:
    return path.basename(m.name);
  }

  return {
    // make sure to use string for id, graphviz npm library fails on non-strings
    graphId: m.id.toString(),
    label: moduleDisplayText().replace(/"/g, /'/),
    depth: m.depth,
    issuers: m.reasons
      // Filter out the "entry" reason, which is redundant as far as I can tell
      .filter(d => d.type !== 'entry' && !d.type.includes('self exports reference'))
      // Stats.js filters out modules only https://github.com/webpack/webpack/blob/5433b8cc785c6e71c29ce5f932ae6595f2d7acb5/lib/Stats.js#L335
      .map(d => ({
        // again make sure to use string for id:
        graphId: d.moduleId.toString(),
        type: d.type,
      })),
    fileExtension: path.parse(m.name).ext,
    source: m.source,
    size: m.size,
    packageDetails: packageDetails,
    name: m.name,
    hasExports: !!m.providedExports,
    providedExports: m.providedExports || [],
    usedExports: m.usedExports || [],
    index: m.index,
    index2: m.index2,
    reasons: m.reasons,
  }
}

function buildGraph(stats) {

  const graph = graphviz.digraph('G');
  graph.set('rankdir', 'LR');
  // note - can be illustrative to turn off clustering to see how all modules are really just connected and actually chunks delineate modules
  // graph.set('clusterrank', 'global');
  if (!bigGraph) {
    // note: ortho doesn't work well with large graphs
    graph.set('splines', 'ortho');
    // nslimit might speed up graph generation for large graphs, TBD
    // graph.set('nslimit', 1);
  }
  graph.set('fontsize', 12);

  graph.set('label', stats.hash);
  graph.set('labelloc', 't');
  graph.setNodeAttribut('fontsize', 12);
  graph.setEdgeAttribut('fontsize', 10);
  graph.setNodeAttribut('width', 0);
  graph.setNodeAttribut('height', 0);
  graph.setNodeAttribut('margin', [0.2, 0.1]);
  const fontNames = 'gotham-book,sans-serif';
  graph.set('fontname', fontNames);
  graph.setNodeAttribut('fontname', fontNames);
  graph.setEdgeAttribut('fontname', fontNames);

  // Add nodes for assets so we can see relationship between chunks and assets.
  if (showAssets) {
    // enable edges from/to clusters
    graph.set('compound', true);
    stats.assets.forEach(asset => {
      const name = asset.name;
      const fileNode = graph.addNode(`file_${name}`, []);
      const basename = path.basename(name);
      const labels = [needsReadableBasename(basename) ? createReadableBasename(name) : basename];
      if (showSize) {
        labels.push(displaySize(asset.size));
      }
      fileNode.set('labelloc', 'c');
      if (labels.length > 1) {
        fileNode.set('label', `{ ${labels.join('|')} }`);
        fileNode.set('shape', 'record');
      }
      else {
        fileNode.set('label', labels[0]);
        fileNode.set('shape', 'rect');
      }
      setNodeColors(blueHue, fileNode);
    });
  }

  // Modules are clustered by chunk(s) they belongs to.
  // So for each chunk there will be a cluster in the graph.
  // Modules that overlap chunks will be in a cluster that represents that specific combination of overlap.
  // This is done because graphviz doesn't allow overlapping clusters.
  // Also this is done because it is easy to see common modules and potentially use that for optimization.
  const modulesByChunks = _.chain(stats.modules)
    .groupBy(m => m.chunks)
    .entries()
    .value();

  modulesByChunks.forEach(p => {
    const modules = p[1];
    const chunkIds = _.first(modules).chunks;

    const allModules = modules.map(parseModule);
    const allShownModules = allModules
      .filter(showModule)
      .filter(showModulePassTwo)
      // Re-run pass two so that we hide modules whose issuers are hidden in Pass Two. Uhhh, don't keep multi-passing, though
      .filter(showModulePassTwo);

    // const clusterDetails = parseClusterDetails(chunkIds.map(c => stats.chunks[c]));
    const clusterDetails = parseClusterDetails(chunkIds.map(c => stats.chunks.find(chunk => chunk.id === c)));
    const chunkCluster = createStyledCluster(graph, clusterDetails);

    function createModuleNode(cluster, m) {
      const node = cluster.addNode(m.graphId, []);

      const labels = [m.label];
      if (showSize) {
        labels.push(displaySize(m.size));
      }
      if (showExports && m.providedExports && m.providedExports.length > 0) {
        const exports = m.providedExports
          .map(name => ({
            name,
            //isUsed: m.usedExports.indexOf(name) > -1,
          }))
          .map(e => `${e.name}`);
        const exportsStack = ` { ${exports.join('|')}  }`;
        // insert at start so it shows on left side
        labels.splice(0, 0, exportsStack);
      }

      styleModuleNode(node, m);

      /**
       * Filter and de-duplicate `issuers` so that we don't draw edges for hidden issuers. Why:
       *
       * 1. Graphviz adds a node for an edge if its origin / destination node doesn't exist, so
       *    if we've hidden `issuer`'s corresponding node, then we need to determine (here) if
       *    we should skip the edge from the hidden issuer module to module `m`.
       *
       * 2. webpack stats contain one "reason" (from which we derive `issuers`) for each import
       *    from a source file, so if File A imports multiple named exports from File B, there
       *    would be multiple arrows from File A -> File B...unless we de-duplicate `issuers`.
       */
      const shownIssuers = {};
      m.issuers.forEach(issuer => {
        const issuerModule = allShownModules.find(m => m.graphId === issuer.graphId);
        if (issuerModule && issuer.graphId in shownIssuers === false) {
          shownIssuers[issuer.graphId] = issuer;
        }
      });
      Object.values(shownIssuers).forEach(issuer => {
        const edge = graph.addEdge(issuer.graphId, m.graphId);
        edge.set('arrowsize', '.75');
        edge.set('color', hslToGraphvizHsv([redHue, 58, 45]));
        if (showDependencyTypeAsEdgeLabel) {
          edge.set('label', dependencyDisplayText(issuer));
        }
      });

      node.set('labelloc', 'c');
      const isEntryModule = m.depth === 0;
      if (isEntryModule) {
        // If I want an arrow I can't have record based AFAIK
        node.set('label', labels.join(' | '));
        node.set('shape', 'rarrow');
        node.set('margin', 0.15);
      }
      else if (labels.length > 1) {
        node.set('label', `{ ${labels.join('|')} }`);
        node.set('shape', 'record');
      }
      else {
        node.set('label', labels[0]);
        node.set('shape', 'rect');
      }

      let didSetTooltip = false;
      // adding file content can be problematic, turn this off if you have issues rendering dot -> SVG
      // in this case I'm excluding files over 10,000 bytes (i.e. lodash) which fails to render in both URL and tooltip from my testing
      if (m.source && m.size < 10000) {

        if (showModuleSourceInNodeUrl) {
          const datauri = new DataURI();
          datauri.format('.js', m.source);
          node.set('URL', datauri.content);
        }

        if (showModuleSourceInNodeTooltip) {
          // escape source to play well with dot language as intermediary to title attribute in svg
          const escapedSource = m.source
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '&#10;');
          node.set('tooltip', escapedSource);
          didSetTooltip = true;
        }

      }

      if (!didSetTooltip) {
        node.set(
          'tooltip',
          m.packageDetails && m.packageDetails.name && m.packageDetails.filePath
            ? path.join(m.packageDetails.name, m.packageDetails.filePath)
            : m.name
        );
      }

      return node;
    }

    const npmPackages = allShownModules.filter(m => m.packageDetails.name);
    const appModules = _.difference(allShownModules, npmPackages);

    appModules.forEach(m => createModuleNode(chunkCluster, m));

    _.chain(npmPackages)
      .groupBy(m => m.packageDetails.name)
      .entries()
      .value()
      .forEach(packageModulesGrouping => {
        const packageName = packageModulesGrouping[0]; // key of group by is package name
        const packageCluster = chunkCluster.addCluster(`"cluster_${packageName}"`);
        packageCluster.set('label', packageName);
        packageCluster.set('fillcolor', hslToGraphvizHsv([greenHue, 0, 85]));
        packageCluster.set('color', hslToGraphvizHsv([greenHue, 0, 45]));
        packageCluster.set('style', 'filled');
        // packageCluster.set('URL', resolveNpmPackagePage(packageName));
        // packageCluster.set('target', 'npm');
        const modules = packageModulesGrouping[1];
        modules.forEach(m => {
          const node = createModuleNode(packageCluster, m);
          // set aspects for modules in a package
          // link to unpkg to see source (version won't be guaranteed to be same)
          // node.set('URL', resolveUnpkgFile(m.packageDetails));
          // node.set('target', '_blank');
        });
      });

    clusterDetails.addFileEdgeAfterAllNodesInCluster();
  });

  function resolveNpmPackagePage(nodeModuleName) {
    return url.resolve('https://www.npmjs.com/package/', nodeModuleName);
  }

  function resolveUnpkg(modulePackageDetails) {
    return url.resolve('https://unpkg.com/', modulePackageDetails.name);
  }

  function resolveUnpkgFile(modulePackageDetails) {
    const base = resolveUnpkg(modulePackageDetails);
    return url.resolve(base + '/', modulePackageDetails.filePath);
  }

  // since the above only adds chunks that have modules, now add chunks without modules:
  const chunksWithNoModules = stats.chunks
    .filter(c => !_.some(modulesByChunks, mbc => mbc[0] === c.id.toString()));
  chunksWithNoModules
    .forEach(c => {
      const clusterDetails = parseClusterDetailsFromOneChunk(c);
      const cluster = createStyledCluster(graph, clusterDetails);

      const noModulesId = `no-modules-${clusterDetails.graphId}`;
      const noModules = cluster.addNode(noModulesId, []);
      noModules.set('shape', 'none');
      noModules.set('label', 'No Modules');
      clusterDetails.addFileEdgeAfterAllNodesInCluster();
    });

  return graph;
}

function round(number, decimals) {
  return Number((Math.round(number + 'e' + decimals) + 'e-' + decimals));
}

function displaySize(size) {
  // show bytes up to 99 - because rounding to 1 digit means >= 100 can be seen as KB, MB, etc next level up
  if (size < 100) {
    return size + 'B';
  }
  // convert to KB
  size /= 1024;
  // show KB up to 99
  if (size < 100) {
    return round(size, 1) + 'KB';
  }
  // convert to MB
  size /= 1024;
  // show MB up to 99
  if (size < 100) {
    return round(size, 1) + 'MB';
  }
  // convert to GB
  size /= 1024;
  // this shouldn't happen :)
  return round(size, 1) + 'GB';
}

function createStyledCluster(graph, clusterDetails) {
  const clusterId = `cluster_${clusterDetails.graphId}`;
  const clusterIdQuoted = `"${clusterId}"`;
  // graphviz nodejs lib doesn't add double quotes around cluster IDs - but does when you pass to attributes like ltail :(
  // aggressive merging plugin is a good example of needing quotes because there are combined chunks that have multiple chunk ids combined and I use ' & ' right now to delineate that.
  // the library does add double quotes around node IDs
  const cluster = graph.addCluster(clusterIdQuoted);
  cluster.set('label', clusterDetails.label);
  // hue and saturation at 0 means color plays no role and we're just using lightness (gray)
  cluster.set('fontcolor', hslToGraphvizHsv([0, 0, 28]));
  const clusterBgColor = hslToGraphvizHsv([0, 0, 95]);
  cluster.set('bgcolor', clusterBgColor);
  // color is border color in this configuration
  cluster.set('color', hslToGraphvizHsv([0, 0, 55]));
  // call addFileEdgeAfterAllNodesInCluster later to add node after other nodes (better layout)
  clusterDetails.addFileEdgeAfterAllNodesInCluster = () => addFileEdge(clusterDetails, clusterId, cluster, graph);
  return cluster;
}

function addFileEdge(clusterDetails, clusterId, cluster, graph) {
  if (!showAssets
    || clusterDetails.isVisualOverlap
    || !clusterDetails.files) {
    return;
  }

  let attachToClusterModuleId;
  if (cluster.nodeCount() === 1) {
    // attach to the one node, I've found this has a better layout, YMMV
    const nodeIds = Object.keys(cluster.nodes.items);
    attachToClusterModuleId = _.first(nodeIds);
  }
  else {
    // to create an edge from a cluster to a node, you still have to use a node in the cluster
    // so create a hidden node:
    const hiddenNodeId = `${clusterId}hidden`;
    const hiddenNode = cluster.addNode(hiddenNodeId, []);
    hiddenNode.set('style', 'invis');
    hiddenNode.set('label', '');
    hiddenNode.set('fixedsize', true);
    hiddenNode.set('margin', 0);
    hiddenNode.set('width', 0);
    hiddenNode.set('height', 0);
    attachToClusterModuleId = hiddenNodeId;
  }

  clusterDetails.files.forEach(f => {
    const fileEdge = graph.addEdge(attachToClusterModuleId, `file_${f}`, []);
    fileEdge.set('arrowsize', '.75');
    fileEdge.set('color', hslToGraphvizHsv([blueHue, 58, 45]));
    // set logical tail to cluster so edge starts at cluster, basically graphviz stops rendering edge once it hits cluster, not all the way in to the node
    // ltail will escape passed string ID, so don't escape it
    fileEdge.set('ltail', clusterId);
  });
}

function parseClusterDetails(chunks) {
  if (chunks.length === 1) {
    return parseClusterDetailsFromOneChunk(chunks[0]);
  }
  // remember multiple chunks = overlapping chunks
  const parsedChunks = chunks.map(parseClusterDetailsFromOneChunk);
  return {
    graphId: parsedChunks.map(c => c.graphId).join(' & '),
    // rebuild label so as not to include runtime/not & eager/lazy to avoid confusion in overlap visual groups
    label: 'overlap:\n' + parsedChunks.map(c => c.nameForOverlap).join(' & '),

    // some things we only want to show for overlap clusters
    // other things we only want to show on chunk's cluster itself
    // show bundle's attributes only on it's dedicated cluster (not overlap clusters)
    isVisualOverlap: true,
  };

}

function chunkDisplayName(chunk) {
  if (chunk.names && chunk.names.length > 0) {
    return chunk.names.join(',');
  }
  // if the chunk has no name(s) then use the chunk id
  // example: aggressive merging plugin in webpack/webpack repo
  return chunk.id;
}

function parseClusterDetailsFromOneChunk(chunk) {
  const parsed = {
    graphId: chunk.id,
    label: chunkDisplayName(chunk),
    nameForOverlap: chunkDisplayName(chunk),
    isVisualOverlap: false,
    files: chunk.files,
  };
  // chunk attributes explanation
  // https://survivejs.com/webpack/building/bundle-splitting/#chunk-types-in-webpack
  // todo show chunk relationships? might help with lazy loaded
  if (chunk.entry) {
    parsed.label += ' [entry]';
  }
  if (chunk.initial) {
    parsed.label += ' [initial]';
  }
  if (showSize && chunk.size) {
    parsed.label += ` - ${displaySize(chunk.size)}`;
  }
  if (showChunkHash && chunk.hash) {
    parsed.label += `\n${chunk.hash}`;
  }
  return parsed;
}

function interactiveHtml(svgGraphFileName) {

  return `
<!--
* Copyright (c) 2015 Mountainstorm
*
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in all
* copies or substantial portions of the Software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
* SOFTWARE.
-->
<html>

<head>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.3.4/css/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdn.rawgit.com/mountainstorm/jquery.graphviz.svg/master/css/graphviz.svg.css">
</head>

<style>
    #instructions {
        color: #737373;
        position: absolute;
        font-size: 8pt;
        z-index: 100;
        bottom: 0;
        left: 0;
    }
</style>

<body>
    <h4 id="instructions">Click node to highlight; Shift-scroll to zoom; Esc to unhighlight; use browser zoom to maintain zoom across refreshes</h4>
    <div id="graph" style="width: 100%; height: 100%; overflow: scroll;"></div>

    <script type="text/javascript" src="https://code.jquery.com/jquery-2.1.3.min.js"></script>
    <script type="text/javascript" src="https://cdn.rawgit.com/jquery/jquery-mousewheel/master/jquery.mousewheel.min.js"></script>
    <script type="text/javascript" src="https://cdn.rawgit.com/jquery/jquery-color/master/jquery.color.js"></script>
    <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.3.4/js/bootstrap.min.js"></script>
    <script type="text/javascript" src="https://cdn.rawgit.com/mountainstorm/jquery.graphviz.svg/master/js/jquery.graphviz.svg.js"></script>
    <script type="text/javascript">
        $(document).ready(function () {
            $("#graph").graphviz({
                url: "${svgGraphFileName}",
                shrink: 0,
                ready: function () {
                    const gv = this;
                    gv.nodes().click(function () {
                        let $set = $();
                        $set.push(this);
                        $set = $set.add(gv.linkedFrom(this, true));
                        $set = $set.add(gv.linkedTo(this, true));
                        gv.highlight($set, true);
                        gv.bringToFront($set)
                    });
                    $(document).keydown(function (evt) {
                        if (evt.keyCode === 27) {
                            gv.highlight()
                        }
                    })
                }
            });
        });
    </script>
</body>

</html>`;
}
