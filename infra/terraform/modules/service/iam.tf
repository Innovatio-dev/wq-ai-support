data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

// Used by the ECS agent, not the application: pulls the image, writes logs,
// and resolves the task's SSM secrets before the container starts.
resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

// On the EXECUTION role, not the task role: the agent fetches `secrets` before
// the container exists. Exactly the declared parameters, not a path wildcard.
data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.app_secrets) > 0 ? 1 : 0

  statement {
    sid       = "ReadTaskSecrets"
    actions   = ["ssm:GetParameters"]
    resources = distinct(values(var.app_secrets))
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(var.app_secrets) > 0 ? 1 : 0

  name   = "${var.name_prefix}-ecs-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

// Assumed by the application. It calls no AWS APIs, so it has no policies; it
// exists so granting access later is an attachment, not a task-definition change.
resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task_exec_channels" {
  count = var.enable_execute_command ? 1 : 0

  statement {
    sid = "EcsExecSessionChannels"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_exec_channels" {
  count = var.enable_execute_command ? 1 : 0

  name   = "${var.name_prefix}-ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_exec_channels[0].json
}
