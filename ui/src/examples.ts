import type { Question } from "./jev";

export type Example = { id: string; state: string; questions: Record<string, Question> };

export const EXAMPLES: Example[] = [
  {
    id: "support",
    state: "Customer message: I was charged twice for my subscription this month and I need the refund today, this is the third time I write to you!",
    questions: {
      is_urgent: {
        type: "noul",
        instructions: "Does the customer need this handled urgently?",
        criteria: { true: "Time-sensitive or escalating", false: "Can wait for the normal queue" },
      },
      department: {
        type: "choice",
        instructions: "Which team should own this ticket?",
        criteria: { billing: "Payments, refunds, invoices", technical: "Bugs, outages, setup", sales: "Plans and pricing" },
      },
      frustration: {
        type: "score",
        instructions: "How frustrated is the customer?",
        criteria: ["Calm", "Mildly annoyed", "Frustrated", "Very angry"],
      },
    },
  },
  {
    id: "moderation",
    state: "Comment: Great tutorial! Check my profile for free crypto giveaways, limited time only!!!",
    questions: {
      is_spam: { type: "noul", instructions: "Is this comment spam or self-promotion?" },
      action: {
        type: "choice",
        instructions: "What should the moderator do?",
        criteria: { approve: "Publish as is", hide: "Hide and keep for review", remove: "Delete and warn the author" },
      },
    },
  },
  {
    id: "review",
    state: "Pull request: renames a public function used by three other services, no deprecation alias, tests updated only in this repository.",
    questions: {
      risk: {
        type: "score",
        instructions: "How risky is merging this change?",
        criteria: ["Safe", "Low", "Moderate", "High", "Critical"],
      },
      needs_owner_review: { type: "noul", instructions: "Should the owners of the other services review it first?" },
    },
  },
];
