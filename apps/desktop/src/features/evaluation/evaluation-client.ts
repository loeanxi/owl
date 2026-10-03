import type { EvaluationRequest, EvaluationResponseMap } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { BridgeClient } from "../../bridge/client.ts";

export class EvaluationClient {
	private readonly bridge: BridgeClient;
	constructor(bridge: BridgeClient) { this.bridge = bridge; }
	async query<A extends EvaluationRequest["action"]>(request: Extract<EvaluationRequest, { action: A }>): Promise<EvaluationResponseMap[A]> {
		const response = await this.bridge.request<EvaluationResponseMap[A]>({ type: "evaluation.request", request });
		if (!response.ok) throw new Error(response.error ?? "Evaluation request failed");
		if (response.result === undefined) throw new Error("Invalid evaluation response");
		return response.result;
	}
}
