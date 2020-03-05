// Copyright (c) 2019 Chair of Applied Cryptography, Technische Universität
// Darmstadt, Germany. All rights reserved. This file is part of go-perun. Use
// of this source code is governed by a MIT-style license that can be found in
// the LICENSE file.

pragma solidity ^0.5.13;
pragma experimental ABIEncoderV2;

library Channel {

    struct Params {
        uint256 challengeDuration;
        uint256 nonce;
        address app;
        address[] participants;
    }

    struct State {
        bytes32 channelID;
        uint64 version;
        Allocation outcome;
        bytes appData;
        bool isFinal;
    }

    struct Allocation {
        address[] assets;
        // Outer dimension are assets, inner dimension are the participants.
        uint256[][] balances;
        SubAlloc[] locked;
    }

    struct SubAlloc {
        // ID is the channelID of the subchannel
        bytes32 ID; // solhint-disable-line var-name-mixedcase
        // balances holds the total balance of the subchannel of every asset.
        uint256[] balances;
    }

    function encodeState(State memory state) internal pure returns (bytes memory)  {
        bytes memory subAlloc = "";
        bytes memory outcome = abi.encode(state.outcome.assets, state.outcome.balances, subAlloc);
        bytes memory stateEnc = abi.encode(state.channelID, state.version, outcome, state.appData, state.isFinal);
        return stateEnc;
    }
}
