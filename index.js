const express = require("express");
const bodyParser = require("body-parser");
const { throttle } = require("throttle-debounce");
const app = express();
// Shhhhh
const host = (() => {
  return "https://just-husky-37.hasura.app/v1/graphql";
})();

const client = require("graphql-client")({
  url: host,
});

// --------------------------------------------------
// Give Glitch a kick in case the project hibernates.

app.use(bodyParser.json());

app.get("/", function (req, res) {
  res.send("The server is alive and well!");
});

// --------------------------------------------------
// Config, "error handling", and execution steps

const fps = 0.3; // Good luck

// This particular demo has to deal with three different problems:
// - The associated Hasura cloud account has max. 6k reqs/min.
// - The associated Glitch account is supposedly unbounded. Let's see.
// - The Heroku database can only handle 10k updates before event logs overflow.
//
// All this to say there's a high chance this will crash. In that case, we'll
// wait five seconds and see whether everything sorts itself out.
const checkLiveness = (request) => {
  if (typeof request.data == "undefined") {
    console.error("Failed request", request);
    setTimeout(update, 5000);
  }

  if (!request.data.config_by_pk.value) {
    console.error("We've paused!");
    throw "Exit";
  }

  return request;
};

// Assuming the above succeeded, we'll also assume the data is the right shape.
// This query should return all 625 rows, so we can build the array in any order
// and rest assured that it probably won't be sparse when we're done.
//
// I don't write much JavaScript these days, so I have no idea whether this is
// what good JavaScript looks like. I'll assume probably not, though.
const prepareCurrentState = ({ data: { life } }) => {
  const result = [];

  life.forEach(({ x, y, state }) => {
    result[y] = result[y] || [];
    result[y][x] = state;
  });

  return result;
};

// Having massaged everything into a sensible shape, we can iterate through
// the board. For each cell, we count the neighbours, and use this count
// to determine the way in which the state will or won't change.
const computeNextStep = (board) => {
  const results = [];

  board.forEach((row, y) => {
    row.forEach((state, x) => {
      let neighbours = 0 - state;

      for (let i = y - 1; i <= y + 1; i++) {
        for (let j = x - 1; j <= x + 1; j++) {
          if (board[i] && board[i][j]) neighbours++;
        }
      }

      const updated = state
        ? neighbours == 2 || neighbours == 3
        : neighbours == 3;

      // We only want to update cells that change.
      if (updated != state) {
        results.push([x, y, updated]);
      }
    });
  });

  return results;
};

// By far the ugliest part of all. Now we know the rows that need to change,
// we put them into a mutation template and send it back from whence it came.
const respond = (updates) => {
  const queries = [];

  updates.forEach(([x, y, state]) => {
    queries.push(`
      { where: {
          x: {_eq: ${x}},
          y: {_eq: ${y}}
        },

        _set: { state: ${state} }
      }
    `);
  });

  return client.query(`
    mutation MyMutation {
      update_life_many(updates: [${queries.join(", ")}]) {
        affected_rows
      }
    } `);
};

// --------------------------------------------------
// All together now!

// The actual program we run every time the event is triggered. This queries
// for the current state of the board, and performs one computational "tick".
const update = () => {
  console.log("tick!");

  return client
    .query(
      `
    query {
      life {
        state
        x
        y
      }
      
      config_by_pk(key: "running") {
        value
      }
    }
  `
    )
    .then(checkLiveness)
    .then(prepareCurrentState)
    .then(computeNextStep)
    .then(respond);
};

// Ticks are throttled at the given fps. Most likely, the fps value should be
// less than 1, as these rate limits are causing many a struggle.
const tick = throttle(
  1000 / fps,
  () =>
    setTimeout(() =>
      update()
        .then((x) => console.log(x))
        .catch((e) => console.error(e))
    ),
  1000 / fps
);

// --------------------------------------------------
// Start the server.

app.post("/", (req, res) => {
  tick();
  res.json({});
});
app.listen(process.env.PORT, () => console.log("We're live!"));
