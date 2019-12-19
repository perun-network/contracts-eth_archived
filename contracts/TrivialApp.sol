// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

pragma solidity ^0.5.13;
pragma experimental ABIEncoderV2;

import "./Channel.sol";
import "./App.sol";

/**
 * @title A trivial App for our testing pipeline.
 * @author The Perun Authors
 * @dev Just does nothing
 */
contract TrivialApp is App {
/**
     * @notice ValidTransition checks if there was a valid transition between two states.
     * @param params The parameters of the channel.
     * @param from The current state.
     * @param to The potenrial next state.
     * @param actorIdx Index of the actor who signed this transition.
     */
    function validTransition(
        Channel.Params calldata params,
        Channel.State calldata from,
        Channel.State calldata to,
        uint256 actorIdx)
    external pure
    {
        // Do nothing, don't revert
    }
}
