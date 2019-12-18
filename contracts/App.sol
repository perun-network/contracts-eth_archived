// Copyright (c) 2019 The Perun Authors. All rights reserved.
// This file is part of go-perun. Use of this source code is governed by a
// MIT-style license that can be found in the LICENSE file.

pragma solidity ^0.5.13;
pragma experimental ABIEncoderV2;

import "./Channel.sol";

interface App {

    /**
     * @notice ValidTransition checks if there was a valid transition between two states.
     * @dev ValidTransition should revert on an invalid transition.
     * Only App specific checks should be performed.
     * The adjudicator already checks the following:
     * - state corresponds to the params
     * - correct dimensions of the allocation
     * - preservation of balances
     * - params.participants[actorIdx] signed the to state
     * @param params The parameters of the channel.
     * @param from The current state.
     * @param to The potenrial next state.
     * @param actorIdx Index of the actor who signed this transition.
     */
    function validTransition(
        Channel.Params calldata params,
        Channel.State calldata from,
        Channel.State calldata to,
        uint256 actorIdx
    ) external pure returns (bool);
}
