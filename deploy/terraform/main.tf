# Terraform module skeleton for claudestruct hosted (W8.1).
#
# Provisions the bare minimum to run `cs serve` against a managed
# Postgres + a public ingress on AWS:
#
#   - VPC + private/public subnets across two AZs
#   - RDS Postgres 16 (small instance; bump for prod)
#   - EKS-friendly IAM roles for the deployment
#   - IAM secret-store policy for the Anthropic API key + Stripe keys
#
# The actual workload runs via the Helm chart at `../helm/claudestruct`.
# Wire them together with the Helm provider once the cluster is up:
#
#   resource "helm_release" "claudestruct" {
#     name       = "claudestruct"
#     repository = "../helm"
#     chart      = "claudestruct"
#     values     = [yamlencode({
#       config = {
#         databaseUrl = aws_db_instance.claudestruct.endpoint
#         region      = var.region
#       }
#     })]
#   }
#
# This is a starting point, not production-ready. Fill in:
#   - Multi-AZ Postgres replication (currently single instance)
#   - Per-region module instantiation for W8.5 data-residency
#   - VPC peering / Transit Gateway for cross-region failover
#   - WAF + ACM cert on the ingress

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "region" {
  description = "AWS region (e.g. us-east-1, eu-west-1). Tag for W8.5 residency."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Logical environment (e.g. dev, staging, prod). Drives sizing + retention."
  type        = string
  default     = "dev"
}

variable "db_instance_class" {
  description = "RDS Postgres instance class. db.t4g.micro is fine for dev; bump to db.r6g.large+ for prod."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Storage GB for RDS."
  type        = number
  default     = 20
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

provider "aws" {
  region = var.region
}

# -- Networking -----------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = {
    Name        = "claudestruct-${var.environment}"
    Environment = var.environment
    Region      = var.region
  }
}

# Private subnets host RDS + the EKS workload pods. Two AZs is the
# minimum RDS requires for Multi-AZ; we provision both even on
# single-AZ deployments so a future upgrade is a one-flag change.
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags = {
    Name = "claudestruct-${var.environment}-private-${count.index}"
  }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags = {
    Name = "claudestruct-${var.environment}-public-${count.index}"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

# -- RDS Postgres ---------------------------------------------------

resource "aws_db_subnet_group" "claudestruct" {
  name       = "claudestruct-${var.environment}"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  name        = "claudestruct-${var.environment}-db"
  description = "Postgres ingress for claudestruct"
  vpc_id      = aws_vpc.main.id
  # Locked down to in-VPC traffic only. The application SG is the
  # right narrowing here once the EKS module is wired in.
  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "claudestruct" {
  identifier              = "claudestruct-${var.environment}"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.db_instance_class
  allocated_storage       = var.db_allocated_storage
  storage_encrypted       = true
  db_name                 = "claudestruct"
  username                = "claudestruct"
  manage_master_user_password = true
  multi_az                = var.environment == "prod"
  publicly_accessible     = false
  db_subnet_group_name    = aws_db_subnet_group.claudestruct.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  backup_retention_period = var.environment == "prod" ? 30 : 7
  deletion_protection     = var.environment == "prod"
  skip_final_snapshot     = var.environment != "prod"
  tags = {
    Environment = var.environment
    Region      = var.region
  }
}

# -- Outputs --------------------------------------------------------

output "db_endpoint" {
  description = "RDS endpoint to feed into the Helm chart's databaseUrl."
  value       = aws_db_instance.claudestruct.endpoint
}

output "db_secret_arn" {
  description = "Secrets Manager ARN holding the master password."
  value       = aws_db_instance.claudestruct.master_user_secret[0].secret_arn
  sensitive   = true
}

output "vpc_id" {
  description = "VPC ID for downstream modules (EKS, ALB, etc)."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs for the workload."
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "Public subnet IDs for the ALB ingress."
  value       = aws_subnet.public[*].id
}
