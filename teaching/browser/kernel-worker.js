// Classic Worker: TeaVM exports main into this isolated global scope.
importScripts("./kernel.js");
self.onmessage = ({ data }) => self.marsReceive(JSON.stringify(data));
self.main([], (error) => {
  if (error) throw error;
});
