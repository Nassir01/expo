"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePackageListAsync = exports.resolveModulesAsync = exports.verifySearchResults = exports.mergeLinkingOptionsAsync = exports.findModulesAsync = exports.findDefaultPathsAsync = exports.findPackageJsonPathAsync = exports.resolveSearchPathsAsync = void 0;
const chalk_1 = __importDefault(require("chalk"));
const fast_glob_1 = __importDefault(require("fast-glob"));
const find_up_1 = __importDefault(require("find-up"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
// Names of the config files. From lowest to highest priority.
const EXPO_MODULE_CONFIG_FILENAMES = ['unimodule.json', 'expo-module.config.json'];
/**
 * Resolves autolinking search paths. If none is provided, it accumulates all node_modules when
 * going up through the path components. This makes workspaces work out-of-the-box without any configs.
 */
async function resolveSearchPathsAsync(searchPaths, cwd) {
    return searchPaths && searchPaths.length > 0
        ? searchPaths.map(searchPath => path_1.default.resolve(cwd, searchPath))
        : await findDefaultPathsAsync(cwd);
}
exports.resolveSearchPathsAsync = resolveSearchPathsAsync;
/**
 * Finds project's package.json and returns its path.
 */
async function findPackageJsonPathAsync() {
    return (await find_up_1.default('package.json', { cwd: process.cwd() })) ?? null;
}
exports.findPackageJsonPathAsync = findPackageJsonPathAsync;
/**
 * Looks up for workspace's `node_modules` paths.
 */
async function findDefaultPathsAsync(cwd) {
    const paths = [];
    let dir = cwd;
    let pkgJsonPath;
    while ((pkgJsonPath = await find_up_1.default('package.json', { cwd: dir }))) {
        dir = path_1.default.dirname(path_1.default.dirname(pkgJsonPath));
        paths.push(path_1.default.join(pkgJsonPath, '..', 'node_modules'));
    }
    return paths;
}
exports.findDefaultPathsAsync = findDefaultPathsAsync;
/**
 * Searches for modules to link based on given config.
 */
async function findModulesAsync(providedOptions) {
    const options = await mergeLinkingOptionsAsync(providedOptions);
    const results = {};
    for (const searchPath of options.searchPaths) {
        const bracedFilenames = '{' + EXPO_MODULE_CONFIG_FILENAMES.join(',') + '}';
        const paths = await fast_glob_1.default([`*/${bracedFilenames}`, `@*/*/${bracedFilenames}`], {
            cwd: searchPath,
        });
        // If the package has multiple configs (e.g. `unimodule.json` and `expo-module.config.json` during the transition time)
        // then we want to give `expo-module.config.json` the priority.
        const uniqueConfigPaths = Object.values(paths.reduce((acc, configPath) => {
            const dirname = path_1.default.dirname(configPath);
            if (!acc[dirname] || configPriority(configPath) > configPriority(acc[dirname])) {
                acc[dirname] = configPath;
            }
            return acc;
        }, {}));
        for (const packageConfigPath of uniqueConfigPaths) {
            const packagePath = await fs_extra_1.default.realpath(path_1.default.join(searchPath, path_1.default.dirname(packageConfigPath)));
            const packageConfig = require(path_1.default.join(packagePath, path_1.default.basename(packageConfigPath)));
            const { name, version } = require(path_1.default.join(packagePath, 'package.json'));
            if (options.exclude?.includes(name) || !packageConfig.platforms?.includes(options.platform)) {
                continue;
            }
            const currentRevision = {
                path: packagePath,
                version,
            };
            if (!results[name]) {
                // The revision that was found first will be the main one.
                // An array of duplicates is needed only here.
                results[name] = { ...currentRevision, duplicates: [] };
            }
            else if (results[name].path !== packagePath &&
                results[name].duplicates?.every(({ path }) => path !== packagePath)) {
                results[name].duplicates?.push(currentRevision);
            }
        }
    }
    return results;
}
exports.findModulesAsync = findModulesAsync;
/**
 * Merges autolinking options from different sources (the later the higher priority)
 * - options defined in package.json's `expoModules` field
 * - platform-specific options from the above (e.g. `expoModules.ios`)
 * - options provided to the CLI command
 */
async function mergeLinkingOptionsAsync(providedOptions) {
    const packageJsonPath = await findPackageJsonPathAsync();
    const packageJson = packageJsonPath ? require(packageJsonPath) : {};
    const baseOptions = packageJson.expo?.autolinking;
    const platformOptions = providedOptions.platform && baseOptions?.[providedOptions.platform];
    const finalOptions = Object.assign({}, baseOptions, platformOptions, providedOptions);
    // Makes provided paths absolute or falls back to default paths if none was provided.
    finalOptions.searchPaths = await resolveSearchPathsAsync(finalOptions.searchPaths, process.cwd());
    return finalOptions;
}
exports.mergeLinkingOptionsAsync = mergeLinkingOptionsAsync;
/**
 * Verifies the search results by checking whether there are no duplicates.
 */
function verifySearchResults(searchResults) {
    const cwd = process.cwd();
    const relativePath = pkg => path_1.default.relative(cwd, pkg.path);
    let counter = 0;
    for (const moduleName in searchResults) {
        const revision = searchResults[moduleName];
        if (revision.duplicates?.length) {
            console.warn(`⚠️  Found multiple revisions of ${chalk_1.default.green(moduleName)}`);
            console.log(` - ${chalk_1.default.magenta(relativePath(revision))} (${chalk_1.default.cyan(revision.version)})`);
            for (const duplicate of revision.duplicates) {
                console.log(` - ${chalk_1.default.gray(relativePath(duplicate))} (${chalk_1.default.gray(duplicate.version)})`);
            }
            counter++;
        }
    }
    if (counter > 0) {
        console.warn('⚠️  Please get rid of multiple revisions as it may introduce some side effects or compatibility issues');
    }
    return counter;
}
exports.verifySearchResults = verifySearchResults;
/**
 * Resolves search results to a list of platform-specific configuration.
 */
async function resolveModulesAsync(searchResults, options) {
    const platformLinking = require(`./platforms/${options.platform}`);
    return (await Promise.all(Object.entries(searchResults).map(async ([packageName, revision]) => {
        const resolvedModule = await platformLinking.resolveModuleAsync(packageName, revision, options);
        return resolvedModule
            ? {
                packageName,
                packageVersion: revision.version,
                ...resolvedModule,
            }
            : null;
    })))
        .filter(Boolean)
        .sort((a, b) => a.packageName.localeCompare(b.packageName));
}
exports.resolveModulesAsync = resolveModulesAsync;
/**
 * Generates a source file listing all packages to link.
 * Right know it works only for Android platform.
 */
async function generatePackageListAsync(modules, options) {
    try {
        const platformLinking = require(`./platforms/${options.platform}`);
        await platformLinking.generatePackageListAsync(modules, options.target, options.namespace);
    }
    catch (e) {
        console.error(chalk_1.default.red(`Generating package list is not available for platform: ${options.platform}`));
    }
}
exports.generatePackageListAsync = generatePackageListAsync;
/**
 * Returns the priority of the config at given path. Higher number means higher priority.
 */
function configPriority(fullpath) {
    return EXPO_MODULE_CONFIG_FILENAMES.indexOf(path_1.default.basename(fullpath));
}
//# sourceMappingURL=autolinking.js.map