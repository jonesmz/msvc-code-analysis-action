"use strict";

const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const util = require('util');

const RelativeRulesetPath = '..\\..\\..\\..\\..\\..\\..\\Team Tools\\Static Analysis Tools\\Rule Sets';

/**
 * Add Quoted command-line argument for MSVC that handles spaces and trailing backslashes.
 * @param {*} arg           command-line argument to quote
 * @returns Promise<string> quoted command-lin argument
 */
function escapeArgument(arg) {
  // find number of consecutive trailing backslashes
  var i = 0;
  while (i < arg.length && arg[arg.length - 1 - i] == '\\') {
    i++;
  }

  // escape all trailing backslashes
  if (i > 0) {
    arg += new Array(i + 1).join('\\');
  }

  return '"' + arg + '"';
}

/**
 * Extract the version number of the compiler by depending on the known filepath format inside of
 * Visual Studio.
 * @param {*} path path to the MSVC compiler
 * @returns the MSVC toolset version number
 */
function extractVersionFromCompilerPath(path) {
  versionDir = path.join(path, "../../..");
  return path.basename(versionDir);
}

/**
 * Extract the default compiler includes by searching known directories in the toolset + OS.
 * @param {*} path path to the MSVC compiler
 * @returns array of default includes used by the given MSVC toolset
 */
function extractIncludesFromCompilerPath(path) {
  includeDir = path.join(path, "../../../include");
  // TODO: extract includes from Windows SDK tied to the given toolset.
  return [ path.normalize(includeDir) ];
}

/**
 * Validate and resolve action input path by making non-absolute paths relative to
 * GitHub repository root.
 * @param {*} input name of GitHub action input variable
 * @param {*} required if true the input must be non-empty
 * @returns the absolute path to the input path if specified.
 */
function resolveInputPath(input, required = false) {
  var inputPath = core.getInput(input);

  if (!inputPath) {
    if (required) {
      throw new Error(input + " input path can not be empty.");
    }
  }

  if (!path.isAbsolute(inputPath)) {
    // make path relative to the repo root if not absolute
    inputPath = path.join(process.env.GITHUB_WORKSPACE, inputPath);
  }

  return inputPath;
}

/**
 * Class for interacting with the CMake file API.
 */
class CMakeApi {
  constructor() {
    this.loaded = false;

    this.cCompilerInfo = undefined;
    this.cxxCompilerInfo = undefined;

    this.sourceRoot = undefined;
    this.cache = {};
    this.targetFilepaths = [];
  }

  static clientName = "client-msvc-ca-action";

  /**
   * Read and parse json reply file
   * @param {*} replyFile Absolute path to json reply
   * @returns Parsed json data of the reply file
   */
  _parseReplyFile(replyFile) {
    if (!replyFile) {
      throw new Error("Failed to find CMake API reply file.");
    }

    if (!fs.existsSync(replyFile)) {
      throw new Error("Failed to find CMake API reply file: " + replyFile);
    }

    let jsonData = fs.readFileSync(replyFile, err => {
      if (err) {
        throw new Error("Failed to read CMake API reply file: " + replyFile, err);
      }
    });

    return JSON.parse(jsonData);
  }

  /**
   * Create a query file for the CMake API
   * @param {*} apiDir CMake API directory '.cmake/api/v1'
   * @param {*} cmakeVersion CMake version to limit data that can be requested
   */
  _createApiQuery(apiDir, cmakeVersion) {
    const queryDir = path.join(apiDir, "query", CMakeApi.clientName);
    fs.mkdirSync(queryDir);

    const queryDataLegacy = {
      requests: [
        { kind: "cache", version: "2" },
        { kind: "codemodel", version: "2" }
      ]
    };

    const queryDataWithToolchains = {
      requests: [
        { kind: "cache", version: "2" },
        { kind: "codemodel", version: "2" },
        { kind: "toolchains", version: "1" }
      ]
    };

    const queryData = cmakeVersion > "3.20.5" ? queryDataLegacy : queryDataWithToolchains;
    const queryFile = path.join(queryDir, "query.json");
    fs.writeFile(queryFile, JSON.stringify(queryData), err => {
      if (err) {
        throw new Error("Failed to write query.json file for CMake API.", err);
      }
    });
  }

  /**
   * Load the reply index file for the CMake API
   * @param {*} apiDir CMake API directory '.cmake/api/v1'
   * @returns parsed json data for reply/index-xxx.json
   */
  _getApiReplyIndex(apiDir) {
    let indexFilepath;
    const replyDir = path.join(apiDir, "reply");
    for (const filepath of fs.readdirSync(replyDir)) {
      if (path.basename(filepath).startsWith("index-")) {
        // Get the most recent index query file (ordered lexicographically)
        if (!indexFilepath || filepath > indexFilepath) {
          indexFilepath = filepath;
        }
      };
    }

    if (!indexFilepath) {
      throw new Error("Failed to find CMake API index reply file.");
    }

    return this._parseReplyFile(indexFilepath);
  }

  /**
   * Load the reply cache file for the CMake API
   * @param {*} cacheJsonFile json filepath for the cache reply data
   */
  _loadCache(cacheJsonFile) {
    const data = this._parseReplyFile(cacheJsonFile);

    // ignore entry type and just store name and string-value pair.
    for (const entry of data.entries) {
      this.cache[entry.name] = entry.value;
    }
  }

  /**
   * Load the reply codemodel file for the CMake API
   * @param {*} replyDir directory for CMake API reply files
   * @param {*} codemodelJsonFile json filepath for the codemodel reply data
   */
  _loadCodemodel(replyDir, codemodelJsonFile) {
    const data = this._parseReplyFile(codemodelJsonFile);

    // TODO: let the user decide which configuration in multi-config generators
    for (const target of data.configurations[0].targets) {
      this.targetFilepaths.push(path.join(replyDir, target.jsonFile));
    }

    this.sourceRoot = data.paths.source;
  }

  /**
   * Load the reply toolset file for the CMake API
   * @param {*} toolsetJsonFile json filepath for the toolset reply data
   */
  _loadToolchains(toolsetJsonFile) {
    const data = this._parseReplyFile(toolsetJsonFile);

    for (const toolchain of data.toolchains) {
      let compiler = toolchain.compiler;
      if (toolchain.language == "C" && compiler.id == "MSVC") {
        this.cCompilerInfo = {
          path: compiler.path,
          version: compiler.version,
          includes: compiler.includeDirectories
        };
      } else if (toolchain.language == "CXX" && compiler.id == "MSVC") {
        this.cxxCompilerInfo = {
          path: compiler.path,
          version: compiler.version,
          includes: compiler.includeDirectories
        };
      }
    }

    if (!this.cCompilerInfo && !this.cxxCompilerInfo) {
      throw new Error("Action requires use of MSVC for either/both C or C++.");
    }
  }

  /**
   * Attempt to load toolset information from CMake cache and known paths because the toolset reply
   * API is not available in CMake version < 3.20
   */
  _loadToolchainsFromCache() {
    let cPath = this.cache["CMAKE_C_COMPILER"];
    if (cPath.endsWith("cl.exe") && cPath.endsWith("cl")) {
      this.cCompilerInfo = {
        path: cPath,
        version: extractVersionFromCompilerPath(cPath),
        includes: extractIncludesFromCompilerPath(cPath)
      };
    }

    let cxxPath = this.cache["CMAKE_CXX_COMPILER"];
    if (cxxPath.endsWith("cl.exe") && cxxPath.endsWith("cl")) {
      this.cxxCompilerInfo = {
        path: cxxPath,
        version: extractVersionFromCompilerPath(cxxPath),
        includes: extractIncludesFromCompilerPath(cxxPath)
      };
    }

    if (!this.cCompilerInfo && !this.cxxCompilerInfo) {
      throw new Error("Action requires use of MSVC for either/both C or C++.");
    }
  }

  /**
   * 
   * @param {*} apiDir CMake API directory '.cmake/api/v1'
   */
  _loadReplyFiles(apiDir) {
    let cacheLoaded = false;
    let codemodelLoaded = false;
    let toolchainLoaded = false;
    const replyDir = path.join(apiDir, "reply");
    const indexReply = this._getApiReplyIndex(apiDir);
    for (const response of indexReply.reply[CMakeApi.clientName]["query.json"].responses) {
      switch (response["kind"]) {
        case "cache":
          cacheLoaded = true;
          this._loadCache(path.join(replyDir, response.jsonFile));
          break;
        case "codemodel":
          codemodelLoaded = true;
          this._loadCodemodel(replyDir, path.join(replyDir, response.jsonFile));
          break;
        case "toolchains":
          toolchainLoaded = true;
          this._loadToolchains(path.join(replyDir, response.jsonFile));
          break;
        default:
          throw new Error("CMakeApi: Unknown reply response kind received: " + response.kind);
      }
    }

    if (!cacheLoaded) {
      throw new Error("Failed to load cache response from CMake API");
    }

    if (!codemodelLoaded) {
      throw new Error("Failed to load codemodel response from CMake API");
    }

    if (!toolchainLoaded) {
      this._loadToolchainsFromCache();
    }
  }

  /**
   * Construct compile-command arguments from compile group information.
   * @param {*} group json data for compile-command data
   * @param {*} options options for different command-line options (see getCompileCommands)
   * @returns compile-command arguments joined into one string
   */
  _getCompileGroupArguments(group, options)
  {
    compileArguments = [];
    for (const command of group.compileCommandFragments) {
      compileArguments.push(command.fragment);
    }

    for (const include of group.includes) {
      if (options.useExternalIncludes) {
        // TODO: filter compilers that don't support /external.
        compileArguments.push(escapeArgument(util.format('/external:I%s', include)));
      } else {
        compileArguments.push(escapeArgument(util.format('/I%s', include)));
      }
    }

    for (const define of indexReply.reply[CMakeApi.clientName].group.defines) {
      compileArguments.push(escapeArgument(util.format('/D%s', define.define)));
    }

    // TODO: handle pre-compiled headers

    return compileArguments.join("");
  }

  // --------------
  // Public methods
  // --------------

  /**
   * Create a query to the CMake API of an existing already configured CMake project. This will:
   *  - Read existing default reply data to find CMake
   *  - Create a query file for all data needed
   *  - Re-run CMake config to generated reply data
   *  - Read reply data and collect all non-target related info
   * 
   * loadApi is required to call any other methods on this class.
   * @param {*} buildRoot directory of CMake build
   */
  loadApi(buildRoot) {
    if (!buildRoot) {
      throw new Error("CMakeApi: 'buildRoot' can not be null or empty.");
    }

    if (!fs.existsSync(buildRoot)) {
      throw new Error("Generated build root for CMake not found at: " + buildRoot);
    }

    const apiDir = path.join(buildRoot, ".cmake/api/v1");
    if (!fs.existsSync(apiDir)) {
      throw new Error(".cmake/api/v1 missing, run CMake config before using action.");
    }

    // read existing reply index to get CMake executable and version
    const indexQuery = this._getApiReplyIndex(apiDir);
    const cmakeVersion = indexQuery.version.string;
    if (cmakeVersion < "3.13.7") {
      throw new Error("Action requires CMake version >= 3.13.7");
    }

    const cmakePath = indexQuery.paths.cmake;
    if (!fs.existsSync(cmakePath)) {
      throw new Error("Unable to find CMake used to build project at: " + cmakePath);
    }

    this._createApiQuery(apiDir, cmakeVersion)

    // regenerate CMake build directory to acquire CMake file API reply
    child_process.spawn(cmakePath, buildRoot, (err) => {
      if (err) {
        throw new Error("Unable to run CMake used previously to build cmake project.");
      }
    });

    this._loadReplyFiles(apiDir);

    this.loaded = true;
  }

  /**
   * 
   * @param {*} target json filepath for the target reply data
   * @param {*} options options for different command-line options:
   *                    - useExternalIncludes: use /external to ignore CMake SYSTEM headers
   * @returns command-line data for each source file in the given target
   */
  * compileCommandsIterator(target, options = {}) {
    if (!this.loaded) {
      throw new Error("CMakeApi: getCompileCommands called before API is loaded");
    }

    for (target in this.targetFilepaths) {
      targetData = _parseReplyFile(target);
      for (var group of targetData.compileGroups) {
        compilerInfo = undefined;
        switch (group.language) {
          case 'C':
            compilerInfo = this.cCompilerInfo;
            break;
          case 'CXX':
            compilerInfo = this.cxxCompilerInfo;
            break;
        }
  
        if (compilerInfo) {
          args = this._getCompileGroupArguments(group, options);
          for (var sourceIndex of group.sourceIndexes) {
            source = path.join(this.sourceRoot, targetData.sources[sourceIndex]);
            var compileCommand = {
              source: source,
              arguments: args,
              compiler: compilerInfo
            };
            yield compileCommand;
          }
        }
      }
    }
  }
}

/**
 * Find EspXEngine.dll as it only exists in host/target bin for MSVC Visual Studio release.
 * @param {*} clPath path to the MSVC c ompiler
 * @returns path to EspXEngine.dll
 */
function findEspXEngine(clPath) {
  const clDir = path.dirname(clPath);

  // check if we already have the correct host/target pair
  var dllPath = path.join(clDir, 'EspXEngine.dll');
  if (fs.existsSync(dllPath)) {
    return dllPath;
  }

  var targetName = '';
  var hostDir = path.dirname(clDir);
  switch (path.basename(hostDir)) {
    case 'HostX86':
      targetName = 'x86';
      break;
    case 'HostX64':
      targetName = 'x64';
      break;
    default:
      throw new Error('Unknown MSVC toolset layout');
  }

  dllPath = path.join(hostDir, targetName, 'EspXEngine.dll');
  if (fs.existsSync(dllPath)) {
    return dllPath;
  }

  throw new Error('Unable to find EspXEngine.dll');
}

/**
 * Find official ruleset directory using the known path of MSVC compiler in Visual Studio.
 * @param {*} clPath path to the MSVC compiler
 * @returns path to directory containing all Visual Studio rulesets
 */
function findRulesetDirectory(clPath) {
  const rulesetDirectory = path.normalize(path.join(path.dirname(clPath), RelativeRulesetPath));
  return fs.existsSync(rulesetDirectory) ? rulesetDirectory : undefined;
}

/**
 * 
 * @param {*} rulesetDirectory path to directory containing all Visual Studio rulesets
 * @returns path to rulset found locally or inside Visual Studio
 */
function findRuleset(rulesetDirectory) {
  var repoRulesetPath = resolveInputPath("ruleset");
  if (!repoRulesetPath) {
    return undefined;
  } else if (fs.existsSync(repoRulesetPath)) {
    return repoRulesetPath;
  }

  // search official ruleset directory that ships inside of Visual Studio
  const rulesetPath = core.getInput("ruleset");
  if (rulesetDirectory != undefined) {
    const officialRulesetPath = path.join(rulesetDirectory, rulesetPath);
    if (fs.existsSync(officialRulesetPath)) {
      return officialRulesetPath;
    }
  } else {
    core.warning("Unable to find official rulesets shipped with Visual Studio");
  }

  throw new Error("Unable to fine ruleset specified: " + rulesetPath);
}

/**
 * Construct all command-line arguments that will be common among all sources files of a given compiler.
 * @param {*} clPath path to the MSVC compiler
 * @returns analyze arguments concatinated into a single string.
 */
function getCommonAnalyzeArguments(clPath, options = {}) {
  args = " /analyze:quiet /analyze:log:format:sarif";

  espXEngine = findEspXEngine(clPath);
  args += escapeArgument(util.format(" /analyze:plugin%s", espXEngine));

  const rulesetDirectory = findRulesetDirectory(clPath);
  const rulesetPath = findRuleset(rulesetDirectory);
  if (rulesetPath != undefined) {
    args += escapeArgument(util.format(" /analyze:ruleset%s", rulesetPath))

    // add ruleset directories incase user includes any official rulesets
    if (rulesetDirectory != undefined) {
      args += escapeArgument(util.format(" /analyze:rulesetdirectory%s", rulesetDirectory));
    }
  } else {
    core.warning('Ruleset is not being used, all warnings will be enabled.');
  }

  if (options[useExternalIncludes]) {
    args += "/analyze:external-";
  }

  return args;
}

/**
 * Get 'results' directory action input and cleanup any stale SARIF files.
 * @returns the absolute path to the 'results' directory for SARIF files.
 */
 function prepareResultsDir() {
  var outputDir = resolveInputPath("results", true);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, {recursive: true}, err => {
      if (err) {
        throw new Error("Failed to create 'results' directory which did not exist.");
      }
    });
  }

  var cleanSarif = core.getInput('cleanSarif');
  switch (cleanSarif.toLowerCase()) {
    case 'true':
    {
      // delete existing Sarif files that are consider stale
      for (var file of fs.readdirSync(outputDir)) {
        if (file.isFile() && path.extname(file.name).toLowerCase() == '.sarif') {
          fs.unlinkSync(path.join(outputDir, file.name));
        }
      }
      break;
    }
    case 'false':
      break;
    default:
      throw new Error('Unsupported value for \'cleanSarif\'. Must be either \'True\' or \'False\'');
  }

  return outputDir;
}

/**
 * Main
 */
if (require.main === module) {
  try {
    var buildDir = resolveInputPath("cmakeBuildDir", true);
    if (!fs.existsSync(repoRulesetPath)) {
      throw new Error("CMake build directory does not exist. Ensure CMake is already configured.");
    }

    var resultsDir = prepareResultsDir();

    api = CMakeApi();
    api.loadApi(buildDir);

    var analysisRan = false;
    var commonArgCache = {};
    for (var compileCommand of api.compileCommandsIterator()) {
      clPath = compileCommand.compiler.path;
      if (clPath in commonArgCache) {
        commonArgCache[clPath] = getCommonAnalyzeArguments(clPath);
      }

      // add cmake and analyze arguments
      clArguments = compileCommand.args + commonArgCache[clPath];

      // add argument for unique log filepath in results directory
      // TODO: handle clashing source filenames in project
      sarifFile = path.join(resultsDir, path.basename(compileCommand.source));
      clArguments += escapeArgument(util.format(" /analyze:log%s", sarifFile));

      // add source file
      clArguments += compileCommand.source;

      // enable compatibility mode as GitHub does not support some sarif options
      // TODO: only set on child process (NIT)
      process.env.CAEmitSarifLog = 1;

      // TODO: handle errors and stdout better
      spawn(clPath, clArguments);
      analysisRan = true;
    }

    if (!analysisRan) {
      throw new Error('No C/C++ files were found in the project that could be analyzed.');
    }

  } catch (error) {
    core.setFailed(error.message);
  }
}