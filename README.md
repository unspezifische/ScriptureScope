# ScriptureScope
A website visualization tool for the Bible

This project allows people to view Bible passages, grouped visually by topic, similar to the data visualizations for LLMs and vector databases. It uses the Gensim library for Python to analyize parsed USX (Unified Scripture XML) files, which can be found at the Digital Bible Library: https://thedigitalbiblelibrary.org. There is a bit of a process to get a library card, but if you have one, there are many Bible versions (in many languages) that are freely available without any licensing arangements required. The actual site itself can be found a the https://scripturescope-71f88.web.app

Check out the Gensim Documentation [here]([https://radimrehurek.com/gensim/](https://radimrehurek.com/gensim/auto_examples/index.html##documentation))!

There is a limit to how much information can be gleaned simply from attempting to identify all the topics in a set of text passages. Therefore, I am working to implement a transformer-based analysis method that will work alongside the topic modeling. The hope is that using both can provide a blend of thematic categorization (from topic modeling) and deep semantic relationships (from the transformer model).

