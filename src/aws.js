const { CloudWatchClient, PutMetricAlarmCommand } = require('@aws-sdk/client-cloudwatch');
const { EC2Client, waitUntilInstanceRunning, DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } = require('@aws-sdk/client-ec2');

const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, runnerGroup) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner} --token ${githubRegistrationToken} --runnergroup ${runnerGroup} --labels _group-${runnerGroup},_ec2 --unattended`,
      './run.sh',
    ];
  } else {
    // TODO: Add support for other architectures and newly created runners
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner} --token ${githubRegistrationToken} --runnergroup ${runnerGroup} --labels _group-${runnerGroup},_ec2 --unattended`,
      './run.sh',
    ];
  }
}

async function startEc2Instance(githubRegistrationToken) {
  const ec2 = new EC2Client({ region: config.input.ec2Region});

  if (config.input.ec2ReuseInstance) {
    // Find for existing instance with same tag
    const describeInstancesParams = {
      Filters: [
        {
          Name: 'instance-state-name',
          Values: ['running'],
        },
        {
          Name: 'tag:runnergroup',
          Values: [config.input.runnerGroup],
        }
      ],
    };
    config.input.tags.forEach(tag => {
      describeInstancesParams.Filters.push({
        Name: `tag:${tag.Key}`,
        Values: [tag.Value],
      });
    });

    try {
      const command = new DescribeInstancesCommand(describeInstancesParams);
      const result = await ec2.send(command);
      if (result.Reservations.length > 0) {
        const instanceId = result.Reservations[0].Instances[0].InstanceId;
        core.info(`AWS EC2 instance ${instanceId} is already running`);
        return instanceId;
      }
    } catch (error) {
      core.error('AWS EC2 instance searching error');
      throw error;
    }
  }

  const userData = buildUserDataScript(githubRegistrationToken, config.input.runnerGroup);

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
    const command = new RunInstancesCommand(params);
    const result = await ec2.send(command);
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    // Create new alarm on CloudWatch if auto-terminate is enabled
    if (config.input.autoTermination) {
      const cloudwatch = new CloudWatchClient({ region: config.input.ec2Region });
      const cloudwatchParams = {
        AlarmName: `GithubRunnerChecker-${ec2InstanceId}`,
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
      const command = new PutMetricAlarmCommand(cloudwatchParams);
      await cloudwatch.send(command);
      core.info(`CloudWatch alarm GithubRunnerChecker-${ec2InstanceId} is created`);
    }
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new EC2Client();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    const command = new TerminateInstancesCommand(params);
    await ec2.send(command);
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new EC2Client();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await waitUntilInstanceRunning({
      client: ec2,
      maxWaitTime: 200,
    }, params);
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
