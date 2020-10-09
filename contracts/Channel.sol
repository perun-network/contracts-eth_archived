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

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "./Sig.sol";

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

    /**
     * @notice Calculates the channel's ID from the given parameters.
     * @param params The parameters of the channel.
     * @return The ID of the channel.
     */
    function ID(Params memory params) public pure returns (bytes32) { // solhint-disable func-name-mixedcase
        return keccak256(encodeParams(params));
    }

    /**
     * @notice Calculates the hash of a state.
     * @param state The state to hash.
     * @return The hash of the state.
     */
    function hashState(State memory state) public pure returns (bytes32) {
        return keccak256(encodeState(state));
    }

    /**
     * @notice Checks that `sigs` contains all signatures on the state
     * from the channel participants. Reverts otherwise.
     * @param params The parameters corresponding to the state.
     * @param state The state of the state channel.
     * @param sigs An array of signatures corresponding to the participants
     * of the channel.
     */
    function validateSignatures(
        Params memory params,
        State memory state,
        bytes[] memory sigs)
    internal pure
    {
        bytes memory encodedState = encodeState(state);
        require(params.participants.length == sigs.length, "signatures length mismatch");
        for (uint256 i = 0; i < sigs.length; i++) {
            require(Sig.verify(encodedState, sigs[i], params.participants[i]), "invalid signature");
        }
    }

    function encodeParams(Params memory params) internal pure returns (bytes memory)  {
        return abi.encode(params);
    }

    function encodeState(State memory state) internal pure returns (bytes memory)  {
        return abi.encode(state);
    }
}
