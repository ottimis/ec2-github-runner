const config = require('./config');
const core = require('@actions/core');
const { getRegistrationToken, waitForRunnerRegistered, removeRunner } = require('./gh.js');
const { startEc2Instance, waitForInstanceRunning, terminateEc2Instance } = require('./aws.js');

function setOutput(runnerGroup, ec2InstanceId) {
  core.setOutput('runner-group', runnerGroup);
  core.setOutput('ec2-instance-id', ec2InstanceId);
}

async function start() {
  const runnerGroup = core.getInput('github-runner-group');
  const githubRegistrationToken = await getRegistrationToken();
  const ec2Instance = await startEc2Instance(githubRegistrationToken);
  setOutput(runnerGroup, ec2Instance.ec2InstanceId);
  if (ec2Instance.started)  {
    await waitForInstanceRunning(ec2Instance.ec2InstanceId);
    await waitForRunnerRegistered(runnerGroup);
  }
}

async function stop() {
  await terminateEc2Instance();
  await removeRunner();
}

(async function () {
  try {
    config.input.mode === 'start' ? await start() : await stop();
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
})();
