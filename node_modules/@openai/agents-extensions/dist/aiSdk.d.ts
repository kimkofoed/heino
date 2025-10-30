import type { LanguageModelV2, LanguageModelV2ToolChoice } from '@ai-sdk/provider';
import { Model, ModelRequest, ResponseStreamEvent, Usage, ModelSettingsToolChoice } from '@openai/agents';
/**
 * Wraps a model from the AI SDK that adheres to the LanguageModelV2 spec to be used used as a model
 * in the OpenAI Agents SDK to use other models.
 *
 * While you can use this with the OpenAI models, it is recommended to use the default OpenAI model
 * provider instead.
 *
 * If tracing is enabled, the model will send generation spans to your traces processor.
 *
 * ```ts
 * import { aisdk } from '@openai/agents-extensions';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = aisdk(openai('gpt-4o'));
 *
 * const agent = new Agent({
 *   name: 'My Agent',
 *   model
 * });
 * ```
 *
 * @param model - The Vercel AI SDK model to wrap.
 * @returns The wrapped model.
 */
export declare class AiSdkModel implements Model {
    #private;
    constructor(model: LanguageModelV2);
    getResponse(request: ModelRequest): Promise<{
        readonly responseId: any;
        readonly usage: Usage;
        readonly output: import("@openai/agents").AgentOutputItem[];
        readonly providerData: {
            content: Array<import("@ai-sdk/provider").LanguageModelV2Content>;
            finishReason: import("@ai-sdk/provider").LanguageModelV2FinishReason;
            usage: import("@ai-sdk/provider").LanguageModelV2Usage;
            providerMetadata?: import("@ai-sdk/provider").SharedV2ProviderMetadata;
            request?: {
                body?: unknown;
            };
            response?: import("@ai-sdk/provider").LanguageModelV2ResponseMetadata & {
                headers?: import("@ai-sdk/provider").SharedV2Headers;
                body?: unknown;
            };
            warnings: Array<import("@ai-sdk/provider").LanguageModelV2CallWarning>;
        };
    }>;
    getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent>;
}
/**
 * Wraps a model from the AI SDK that adheres to the LanguageModelV2 spec to be used used as a model
 * in the OpenAI Agents SDK to use other models.
 *
 * While you can use this with the OpenAI models, it is recommended to use the default OpenAI model
 * provider instead.
 *
 * If tracing is enabled, the model will send generation spans to your traces processor.
 *
 * ```ts
 * import { aisdk } from '@openai/agents-extensions';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = aisdk(openai('gpt-4o'));
 *
 * const agent = new Agent({
 *   name: 'My Agent',
 *   model
 * });
 * ```
 *
 * @param model - The Vercel AI SDK model to wrap.
 * @returns The wrapped model.
 */
export declare function aisdk(model: LanguageModelV2): AiSdkModel;
export declare function parseArguments(args: string | undefined | null): any;
export declare function toolChoiceToLanguageV2Format(toolChoice: ModelSettingsToolChoice | undefined): LanguageModelV2ToolChoice | undefined;
