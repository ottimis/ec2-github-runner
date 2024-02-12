const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.299.1/actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  // Find for existing instance with same tag
  const describeInstancesParams = {
    Filters: [],
  };
  config.input.tags.forEach(tag => {
    describeInstancesParams.Filters.push({
      Name: `tag:${tag.Key}`,
      Values: [tag.Value],
    });
  });

  try {
    const result = await ec2.describeInstances(describeInstancesParams).promise();
    if (result.Reservations.length > 0) {
      const instanceId = result.Reservations[0].Instances[0].InstanceId;
      core.info(`AWS EC2 instance ${instanceId} is already running`);
      return instanceId;
    }
  } catch (error) {
    core.error('AWS EC2 instance searching error');
    throw error;
  }

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
  };

  try {
    const result = await ec2.runInstances(params).promise();
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    // Create new alarm on CloudWatch if auto-terminate is enabled
    if (config.input.autoTermination) {
      const cloudwatch = new AWS.CloudWatch();
      const cloudwatchParams = {
        AlarmName: `Terminate-${ec2InstanceId}`,
        ComparisonOperator: 'LessThanThreshold',
        EvaluationPeriods: config.input.terminationDelay,
        MetricName: 'CPUUtilization',
        Namespace: 'AWS/EC2',
        Period: 60,
        Statistic: 'Average',
        Threshold: 1,
        ActionsEnabled: true,
        AlarmDescription: `Terminate instance ${ec2InstanceId} when CPU utilization is less than 1%`,
        Dimensions: [
          {
            Name: 'InstanceId',
            Value: ec2InstanceId,
          },
        ],
        // Terminate the instance
        AlarmActions: [
          `arn:aws:automate:${config.input.ec2Region}:ec2:terminate`
        ],
        Unit: 'Percent',
      };
      await cloudwatch.putMetricAlarm(cloudwatchParams).promise();
      core.info(`CloudWatch alarm Terminate-${ec2InstanceId} is created`);
    }
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
