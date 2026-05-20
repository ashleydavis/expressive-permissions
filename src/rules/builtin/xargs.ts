import { AstNode, IEnvironment, IRule, IRuleOutcome, IToolCall, ABSTAIN } from "../../types";

// xargsRule: built-in semantic rule that matches IXargsNode intermediate nodes.
// Always abstains so that the child Command's decision propagates upward via combine.
// Acts as an explicit extension point, matching the pattern of cdRule and peers.
export const xargsRule: IRule = function xargsRule(node: AstNode, _env: IEnvironment, _call: IToolCall): IRuleOutcome {
    if (node.type !== "xargs") {
        return ABSTAIN;
    }

    return ABSTAIN;
};
