/** Exactly-once execution for card actions that carry side effects. */
import type { CapabilityService } from "./capabilities.js";
import type { Db } from "./db.js";
import type { GithubClient, GithubReviewProposal } from "./github.js";
import { applyDraftLearnAnswer } from "./draftlearn.js";
import { applyQuieterAnswer } from "./notify.js";
import { applyStyleCardAnswer } from "./reactions.js";
import type { Registry } from "./registry.js";
import { RetryableApprovalError } from "./errors.js";
import { todayUtc, type Card, type CardResolution } from "./types.js";

export class ApprovalService {
  constructor(
    private db: Db,
    private capabilities: CapabilityService,
    private github: Pick<GithubClient, "publishReview">,
    /** for answers that change an intern (notification level) */
    private registry?: Registry,
  ) {}

  async handle(cardId: string, actionId: string, resolution: CardResolution): Promise<Card> {
    const card = this.db.getCard(cardId);
    const action = card?.actions.find((a) => a.id === actionId);
    if (!card || !action) throw new Error("no such card/action");
    if (card.state !== "open") return card;

    if (actionId === "reject") this.capabilities.rejectForCard(card.id);
    if (card.context.kind === "budget" && actionId === "extend") return this.extendBudget(card, resolution);
    if (card.context.kind === "notify_suggest" && this.registry) applyQuieterAnswer(this.db, this.registry, card, actionId);
    if (card.context.kind === "draft_learn") applyDraftLearnAnswer(this.db, card, actionId);
    if ((card.context.kind === "style_suggest" || card.context.kind === "style_changed") && this.registry) applyStyleCardAnswer(this.db, this.registry, card, actionId);
    const job = this.db.getApprovalJob(card.id, action.id);
    if (!job) return this.db.resolveCard(card.id, resolution)!;
    if (job.status === "done") return this.db.resolveCard(card.id, resolution)!;
    if (job.status === "running") throw new Error("approval action is already running");
    if (job.status === "failed") throw new Error(`approval action previously failed: ${job.error ?? "unknown error"}`);
    if (!this.db.claimApprovalJob(job.id)) throw new Error("approval action could not be claimed");

    try {
      let result: Record<string, unknown>;
      switch (job.kind) {
        case "capability.approve":
          result = this.capabilities.approve(String(job.payload.request_id));
          break;
        case "capability.activate":
          result = this.capabilities.activate(String(job.payload.request_id));
          break;
        case "github.publish_review":
          result = await this.github.publishReview(job.payload as unknown as GithubReviewProposal);
          break;
      }
      this.db.finishApprovalJob(job.id, result);
      return this.db.resolveCard(card.id, resolution)!;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof RetryableApprovalError) {
        this.db.resetApprovalJob(job.id, reason);
        throw err;
      }
      this.db.failApprovalJob(job.id, reason);
      this.db.createCard({
        intern: "coordinator",
        title: `Approved action failed: ${card.title}`,
        body: `The approval was recorded but no success was confirmed.\n\n> ${reason}\n\nThe original card remains open; inspect before retrying to avoid duplicate outbound actions.`,
        severity: "urgent",
        actions: [{ id: "ack", label: "Acknowledge", style: "neutral", kind: "button" }],
      });
      throw err;
    }
  }

  /**
   * "Can I go over my limit?" → yes: today's limit grows by what the card
   * offered and the work held at the limit goes back in the queue. Only for
   * the day it asked about; after midnight there is nothing to extend.
   */
  private extendBudget(card: Card, resolution: CardResolution): Card {
    const tokens = Number(card.context.tokens);
    if (card.context.day === todayUtc() && tokens > 0) this.db.addBudgetExtra(card.intern, tokens);
    this.db.releaseBudgetHeld(card.intern);
    return this.db.resolveCard(card.id, resolution)!;
  }
}
