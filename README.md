# chore-chart

A minimal serverless **to-do API** demoing backend invocations with **AWS Lambda + API Gateway (HTTP API)**, persisted in **DynamoDB**, all wired up through a single `serverless.yml`.

## Architecture

```
Client ──HTTP──▶ API Gateway (HTTP API) ──invoke──▶ Lambda (one per route) ──▶ DynamoDB
```

Each route maps to its own Lambda function (`sls functions`):

| Method | Path          | Function      | Description        |
| ------ | ------------- | ------------- | ------------------ |
| POST   | `/todos`      | `createTodo`  | Create a to-do     |
| GET    | `/todos`      | `listTodos`   | List all to-dos    |
| GET    | `/todos/{id}` | `getTodo`     | Get one to-do      |
| PUT    | `/todos/{id}` | `updateTodo`  | Update a to-do     |
| DELETE | `/todos/{id}` | `deleteTodo`  | Delete a to-do     |

## Prerequisites

- Node.js 18+ and an AWS account (uses the `default` AWS CLI profile)
- Serverless Framework v4 requires a (free) login/license key. Authenticate once with
  `npx serverless login`, or set `SERVERLESS_ACCESS_KEY` in your environment.

## Setup & deploy

```bash
npm install
npm run deploy            # serverless deploy --stage dev --region us-east-1
```

After deploy, Serverless prints the base URL, e.g.
`https://abc123.execute-api.us-east-1.amazonaws.com`.

## Try it

```bash
API=https://smswvajzoj.execute-api.us-east-1.amazonaws.com/

# create
curl -s -X POST $API/todos -d '{"title":"Take out the trash"}'

# list
curl -s $API/todos

# get one
curl -s $API/todos/<id>

# mark done
curl -s -X PUT $API/todos/<id> -d '{"done":true}'

# delete
curl -s -X DELETE $API/todos/<id> -i
```

## Tear down

```bash
npm run remove
```
