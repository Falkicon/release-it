const path = require('path');
const { EOL } = require('os');
const _ = require('lodash');
const { format } = require('./util');
const shell = require('./shell');
const { config } = require('./config');
const { warn, logError } = require('./log');
const { GitCloneError, GitCommitError, CreateChangelogError } = require('./errors');
const { debugGit } = require('./debug');

const noop = Promise.resolve();
const commitRefRe = /#.+$/;
const invalidPushRepoRe = /^\S+@/;

const isGitRepo = () => shell.run('git rev-parse --git-dir', { isReadOnly: true }).then(() => true, () => false);

const getRootDir = () => shell.run('git rev-parse --show-toplevel', { isReadOnly: true });

const isInGitRootDir = async () => path.relative(process.cwd(), await getRootDir()) === '';

const hasUpstream = () =>
  shell.run('git rev-parse --abbrev-ref --symbolic-full-name @{u}', { isReadOnly: true }).then(() => true, () => false);

const getBranchName = () => shell.run('git rev-parse --abbrev-ref HEAD', { isReadOnly: true }).catch(() => null);

const tagExists = tag =>
  shell
    .run(`git show-ref --tags --quiet --verify -- "refs/tags/${tag}"`, { isReadOnly: true })
    .then(() => true, () => false);

const isRemoteName = remoteUrlOrName => !_.includes(remoteUrlOrName, '/');

const getRemoteUrl = (remoteUrlOrName = 'origin') =>
  isRemoteName(remoteUrlOrName)
    ? shell.run(`git config --get remote.${remoteUrlOrName}.url`, { isReadOnly: true }).catch(() => null)
    : Promise.resolve(remoteUrlOrName);

const isWorkingDirClean = () =>
  shell.run('git diff-index --name-only HEAD --exit-code', { isReadOnly: true }).then(() => true, () => false);

const clone = (repo, dir) => {
  const commitRef = repo.match(commitRefRe);
  const branch = commitRef && commitRef[0] ? `-b ${commitRef[0].replace(/^#/, '')}` : '';
  const cleanRepo = repo.replace(commitRef, '');
  return shell.run(`git clone ${cleanRepo} ${branch} --single-branch ${dir}`).catch(err => {
    logError(`Unable to clone ${repo}`);
    throw new GitCloneError(err);
  });
};

const stage = file => {
  const files = _.castArray(file).join(' ');
  return shell.run(`git add ${files}`).catch(err => {
    debugGit(err);
    warn(`Could not stage ${files}`);
  });
};

const stageDir = ({ baseDir = '.', addUntrackedFiles }) =>
  shell.run(`git add ${baseDir} ${addUntrackedFiles ? '--all' : '--update'}`);

const reset = file => {
  const files = _.castArray(file).join(' ');
  return shell.run(`git checkout HEAD -- ${files}`).catch(err => {
    debugGit(err);
    warn(`Could not reset ${files}`);
  });
};

const status = () => shell.run('git status --short --untracked-files=no', { isReadOnly: true });

const commit = ({ path = '.', message, args = '' }) =>
  shell.runTemplateCommand(`git commit --message="${message}" ${args}`, path).catch(err => {
    debugGit(err);
    if (/nothing (added )?to commit/.test(err)) {
      warn('No changes to commit. The latest commit will be tagged.');
    } else {
      throw new GitCommitError(err);
    }
  });

const tag = ({ name, annotation, args = '' }) => {
  return shell.runTemplateCommand(`git tag --annotate --message="${annotation}" ${args} ${name}`).catch(err => {
    debugGit(err);
    warn(`Could not tag. Does tag "${format(name)}" already exist?`);
  });
};

const getLatestTag = () =>
  shell.run('git describe --tags --abbrev=0', { isReadOnly: true }).then(
    stdout => {
      return stdout ? stdout.replace(/^v/, '') : null;
    },
    () => null
  );

const push = async ({ pushRepo = '', hasUpstreamBranch, args = '' } = {}) => {
  let upstream = 'origin';
  if (pushRepo && !isRemoteName(pushRepo)) {
    upstream = pushRepo;
  } else if (!hasUpstreamBranch) {
    upstream = `-u ${pushRepo || upstream} ${await getBranchName()}`;
  } else if (!invalidPushRepoRe.test(pushRepo)) {
    upstream = pushRepo;
  }
  return shell.run(`git push --follow-tags ${args} ${upstream}`);
};

const runChangelogCommand = command =>
  shell
    .run(command, { isReadOnly: true })
    .then(stdout => {
      if (config.isVerbose) {
        process.stdout.write(EOL);
      }
      return stdout;
    })
    .catch(err => {
      debugGit(err);
      throw new CreateChangelogError(command);
    });

const getChangelog = async ({ command, tagName, latestVersion }) => {
  if (command && (await isInGitRootDir())) {
    if (command.match(/\[REV_RANGE\]/)) {
      const latestTag = format(tagName, { version: latestVersion });
      const hasTag = await tagExists(latestTag);
      const rangeCommand = command.replace(/\[REV_RANGE\]/, hasTag ? `${latestTag}...HEAD` : '');
      return runChangelogCommand(rangeCommand);
    } else if (/^.?git log/.test(command)) {
      return runChangelogCommand(command);
    } else {
      return runChangelogCommand(format(command));
    }
  } else {
    return noop;
  }
};

const isSameRepo = (repoA, repoB) => repoA.repository === repoB.repository && repoA.host === repoB.host;

module.exports = {
  isGitRepo,
  isInGitRootDir,
  hasUpstream,
  getBranchName,
  tagExists,
  getRemoteUrl,
  isWorkingDirClean,
  clone,
  stage,
  stageDir,
  status,
  reset,
  commit,
  tag,
  getLatestTag,
  push,
  runChangelogCommand,
  getChangelog,
  isSameRepo
};
