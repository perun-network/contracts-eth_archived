// Copyright 2019 - See NOTICE file for copyright holders.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
